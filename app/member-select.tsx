"use client";

export type MemberOption = { id: string; name: string; username: string; role: string };

export default function MemberSelect({
  name,
  members,
  defaultValue = "",
  required = false,
  optionalLabel = "未指派",
}: {
  name: string;
  members: MemberOption[];
  defaultValue?: string;
  required?: boolean;
  optionalLabel?: string;
}) {
  const choices = members.filter((member) => member.name.trim());
  const hasCurrent = choices.some((member) => member.name === defaultValue);
  return <select name={name} defaultValue={defaultValue} required={required}>
    <option value="">{required ? "請選擇成員" : optionalLabel}</option>
    {defaultValue && !hasCurrent && <option value={defaultValue}>{defaultValue}（既有指派）</option>}
    {choices.map((member) => <option value={member.name} key={member.id}>{member.name}（@{member.username}）</option>)}
  </select>;
}

export function MemberMultiSelect({
  name,
  members,
  defaultValues = [],
}: {
  name: string;
  members: MemberOption[];
  defaultValues?: string[];
}) {
  const choices = members.filter((member) => member.name.trim());
  const known = new Set(choices.map((member) => member.name));
  return <select name={name} multiple size={Math.min(6, Math.max(3, choices.length))} defaultValue={defaultValues}>
    {defaultValues.filter((value) => value && !known.has(value)).map((value) => <option value={value} key={`legacy-${value}`}>{value}（既有指派）</option>)}
    {choices.map((member) => <option value={member.name} key={member.id}>{member.name}（@{member.username}）</option>)}
  </select>;
}
