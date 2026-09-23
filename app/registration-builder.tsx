"use client";

import { Dispatch, DragEvent, SetStateAction, useState } from "react";
import type { RegistrationField, RegistrationFieldType } from "./registration-types";
import "./registration-builder.css";

export type RegistrationBuilderProps = {
  fields: RegistrationField[];
  setFields: Dispatch<SetStateAction<RegistrationField[]>>;
  locked: boolean;
  busy: boolean;
};

const fieldTypes: Array<[RegistrationFieldType, string]> = [
  ["short_text", "短答"],
  ["long_text", "段落"],
  ["email", "電子郵件"],
  ["phone", "電話"],
  ["number", "數字"],
  ["date", "日期"],
  ["single_choice", "單選"],
  ["select", "下拉選單"],
  ["multiple_choice", "複選"],
  ["checkbox", "同意勾選"],
];

const optionTypes = new Set<RegistrationFieldType>([
  "single_choice",
  "select",
  "multiple_choice",
]);

const uid = () => crypto.randomUUID();
const newOption = (index: number) => `選項 ${index + 1}`;

function canonicalType(field: RegistrationField): RegistrationFieldType {
  if (field.type === "text") return "short_text";
  if (field.type === "textarea") return "long_text";
  if (field.type === "tel") return "phone";
  if (field.type === "radio") return "single_choice";
  if (field.type === "checkbox" && field.options?.length) return "multiple_choice";
  return field.type;
}

function isOptionField(field: RegistrationField) {
  return optionTypes.has(canonicalType(field));
}

function defaultOptions(type: RegistrationFieldType, options?: string[]) {
  if (!optionTypes.has(type)) return undefined;
  return options?.length ? options : ["選項 1", "選項 2"];
}

function AnswerPreview({ field }: { field: RegistrationField }) {
  const type = canonicalType(field);
  const options = field.options?.length ? field.options : ["選項 1", "選項 2"];
  if (type === "long_text") {
    return <textarea aria-label="段落回答預覽" disabled rows={3} placeholder="填答者可輸入較長的內容" />;
  }
  if (type === "single_choice") {
    return <div className="registration-builder-choice-preview">{options.map((option, index) => <span key={`${option}-${index}`}><i className="radio" aria-hidden="true" />{option}</span>)}</div>;
  }
  if (type === "multiple_choice") {
    return <div className="registration-builder-choice-preview">{options.map((option, index) => <span key={`${option}-${index}`}><i className="check" aria-hidden="true" />{option}</span>)}</div>;
  }
  if (type === "select") {
    return <select aria-label="下拉回答預覽" disabled><option>請選擇</option>{options.map((option, index) => <option key={`${option}-${index}`}>{option}</option>)}</select>;
  }
  if (type === "checkbox") {
    return <span className="registration-builder-consent-preview"><i className="check" aria-hidden="true" />我已閱讀並同意</span>;
  }
  const inputType = type === "email" ? "email" : type === "phone" ? "tel" : type === "number" ? "number" : type === "date" ? "date" : "text";
  const placeholder = type === "email" ? "name@example.com" : type === "phone" ? "聯絡電話" : type === "number" ? "數字" : type === "date" ? undefined : "簡短回答";
  return <input aria-label={`${fieldTypes.find(([value]) => value === type)?.[1] ?? "文字"}回答預覽`} type={inputType} disabled placeholder={placeholder} />;
}

export default function RegistrationBuilder({ fields, setFields, locked, busy }: RegistrationBuilderProps) {
  const [dragged, setDragged] = useState<number | null>(null);
  const disabled = locked || busy;

  const update = (id: string, patch: Partial<RegistrationField>) => {
    if (disabled) return;
    setFields((rows) => rows.map((row) => row.id === id ? { ...row, ...patch } : row));
  };

  const move = (from: number, to: number) => {
    if (disabled || from === to || to < 0 || to >= fields.length) return;
    setFields((rows) => {
      if (from < 0 || from >= rows.length || to < 0 || to >= rows.length) return rows;
      const next = [...rows];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  const drop = (event: DragEvent<HTMLElement>, target: number) => {
    event.preventDefault();
    if (dragged !== null) move(dragged, target);
    setDragged(null);
  };

  const duplicate = (field: RegistrationField, index: number) => {
    if (disabled) return;
    const copy: RegistrationField = {
      ...field,
      id: uid(),
      label: `${field.label || "未命名問題"}（副本）`,
      options: field.options ? [...field.options] : undefined,
    };
    setFields((rows) => [...rows.slice(0, index + 1), copy, ...rows.slice(index + 1)]);
  };

  const remove = (id: string) => {
    if (disabled) return;
    setFields((rows) => rows.filter((row) => row.id !== id));
  };

  const changeType = (field: RegistrationField, type: RegistrationFieldType) => {
    update(field.id, { type, options: defaultOptions(type, field.options) });
  };

  const updateOption = (field: RegistrationField, optionIndex: number, value: string) => {
    const options = [...(field.options ?? [])];
    options[optionIndex] = value;
    update(field.id, { options });
  };

  const addOption = (field: RegistrationField) => {
    const options = field.options ?? [];
    update(field.id, { options: [...options, newOption(options.length)] });
  };

  const removeOption = (field: RegistrationField, optionIndex: number) => {
    const options = (field.options ?? []).filter((_, index) => index !== optionIndex);
    update(field.id, { options });
  };

  return <section className="registration-builder" aria-label="報名表問題編輯器" aria-busy={busy}>
    {locked && <p className="registration-builder-locked" role="status">表單目前已鎖定，問題只能查看。</p>}
    <ol className="registration-builder-list">
      {fields.map((field, index) => <li
        className={`registration-builder-card${dragged === index ? " dragging" : ""}`}
        key={field.id}
        draggable={!disabled}
        onDragStart={(event) => {
          setDragged(index);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", field.id);
        }}
        onDragOver={(event) => { if (!disabled) event.preventDefault(); }}
        onDrop={(event) => drop(event, index)}
        onDragEnd={() => setDragged(null)}
      >
        <div className="registration-builder-drag" aria-hidden="true">⠿</div>
        <div className="registration-builder-card-head">
          <span>問題 {index + 1}</span>
          <div className="registration-builder-order-actions">
            <button type="button" disabled={disabled || index === 0} aria-label={`將問題 ${index + 1} 上移`} onClick={() => move(index, index - 1)}>↑</button>
            <button type="button" disabled={disabled || index === fields.length - 1} aria-label={`將問題 ${index + 1} 下移`} onClick={() => move(index, index + 1)}>↓</button>
          </div>
        </div>

        <div className="registration-builder-question-row">
          <label>
            <span>問題標題</span>
            <input value={field.label} disabled={disabled} maxLength={200} placeholder="輸入問題" onChange={(event) => update(field.id, { label: event.target.value })} />
          </label>
          <label>
            <span>回答方式</span>
            <select value={canonicalType(field)} disabled={disabled} onChange={(event) => changeType(field, event.target.value as RegistrationFieldType)}>
              {fieldTypes.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select>
          </label>
        </div>

        {isOptionField(field) && <fieldset className="registration-builder-options" disabled={disabled}>
          <legend>選項</legend>
          {(field.options ?? []).map((option, optionIndex) => <div key={`${field.id}-option-${optionIndex}`}>
            <span className={canonicalType(field) === "multiple_choice" ? "check" : "radio"} aria-hidden="true" />
            <input aria-label={`選項 ${optionIndex + 1}`} value={option} maxLength={200} onChange={(event) => updateOption(field, optionIndex, event.target.value)} />
            <button type="button" aria-label={`刪除選項 ${optionIndex + 1}`} disabled={disabled || (field.options?.length ?? 0) <= 1} onClick={() => removeOption(field, optionIndex)}>×</button>
          </div>)}
          <button className="registration-builder-add-option" type="button" onClick={() => addOption(field)}>＋ 新增選項</button>
        </fieldset>}

        <div className="registration-builder-preview">
          <span>回答預覽</span>
          <AnswerPreview field={field} />
        </div>

        <footer className="registration-builder-footer">
          <div className="registration-builder-secondary-actions">
            <button type="button" disabled={disabled} onClick={() => duplicate(field, index)}>複製</button>
            <button className="danger" type="button" disabled={disabled} onClick={() => remove(field.id)}>刪除</button>
          </div>
          <div className="registration-builder-switches">
            <label><span>必填</span><input type="checkbox" role="switch" disabled={disabled} checked={field.required} onChange={(event) => update(field.id, { required: event.target.checked })} /></label>
            <label><span>個資</span><input type="checkbox" role="switch" disabled={disabled} checked={Boolean(field.sensitive)} onChange={(event) => update(field.id, { sensitive: event.target.checked })} /></label>
          </div>
        </footer>
      </li>)}
    </ol>
    {!fields.length && <div className="registration-builder-empty">尚未加入問題。</div>}
  </section>;
}
