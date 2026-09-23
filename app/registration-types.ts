export const registrationFieldTypes = [
  "short_text",
  "long_text",
  "email",
  "phone",
  "number",
  "date",
  "single_choice",
  "multiple_choice",
  "checkbox",
  // Legacy editor aliases retained while the management UI migrates.
  "text",
  "tel",
  "textarea",
  "select",
  "radio",
] as const;

export type RegistrationFieldType = (typeof registrationFieldTypes)[number];
export type RegistrationFormStatus = "draft" | "open" | "closed";
export type RegistrationSubmissionStatus = "submitted" | "confirmed" | "cancelled";
export type RegistrationPaymentStatus = "unpaid" | "checking" | "paid" | "refunded" | "not_required";
export type RegistrationAnswer = string | string[] | number | boolean | null;

export type RegistrationField = {
  id: string;
  label: string;
  type: RegistrationFieldType;
  required: boolean;
  placeholder?: string;
  helpText?: string;
  options?: string[];
  min?: number;
  max?: number;
  maxLength?: number;
  sensitive?: boolean;
};

export type RegistrationForm = {
  id: string;
  activityId: string;
  title: string;
  description: string;
  status: RegistrationFormStatus;
  fields: RegistrationField[];
  submitLabel?: string;
  confirmationMessage?: string;
  createdAt: string;
  updatedAt?: string;
  privacyNotice: string;
  slug?: string;
  version?: number;
};

export type RegistrationSubmission = {
  id: string;
  formId: string;
  activityId: string;
  answers: Record<string, RegistrationAnswer>;
  consent: boolean;
  status: RegistrationSubmissionStatus;
  paymentStatus?: RegistrationPaymentStatus;
  paymentNote?: string;
  reminderFiveDaysSentAt?: string;
  reminderOneDaySentAt?: string;
  submittedAt: string;
  updatedAt?: string;
};

export type RegistrationState = {
  registrationForms?: RegistrationForm[];
  registrationSubmissions?: RegistrationSubmission[];
};

export type SubmissionValidation =
  | { ok: true; answers: Record<string, RegistrationAnswer>; fieldErrors: Record<string, never> }
  | { ok: false; answers: Record<string, RegistrationAnswer>; fieldErrors: Record<string, string> };

const MAX_FIELDS = 100;
const MAX_OPTIONS = 100;
const MAX_TEXT = 10_000;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phonePattern = /^\+?[0-9 ()-]{7,30}(?:\s*(?:#|x|ext\.?)[0-9]{1,8})?$/i;

export function normalizeRegistrationText(value: unknown, maxLength = MAX_TEXT) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .normalize("NFC")
    .trim()
    .slice(0, Math.max(0, maxLength));
}

export function normalizeRegistrationId(value: unknown, fallback = "") {
  const normalized = normalizeRegistrationText(value, 100).replace(/\s+/g, "-");
  return idPattern.test(normalized) ? normalized : fallback;
}

export function normalizeRegistrationEmail(value: unknown) {
  return normalizeRegistrationText(value, 320).toLocaleLowerCase("en-US");
}

export function normalizeRegistrationPhone(value: unknown) {
  return normalizeRegistrationText(value, 40).replace(/\s+/g, " ");
}

function finiteNumber(value: unknown) {
  if (value === "" || value === null || value === undefined) return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptions(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.slice(0, MAX_OPTIONS).map((item) => normalizeRegistrationText(item, 200)).filter(Boolean)),
  );
}

export function normalizeRegistrationField(value: unknown, index = 0): RegistrationField | null {
  if (!isRecord(value)) return null;
  const type = registrationFieldTypes.includes(value.type as RegistrationFieldType)
    ? (value.type as RegistrationFieldType)
    : "short_text";
  const label = normalizeRegistrationText(value.label, 200);
  if (!label) return null;
  const id = normalizeRegistrationId(value.id, `field-${index + 1}`);
  const options = normalizeOptions(value.options);
  const maxLength = finiteNumber(value.maxLength);
  return {
    id,
    label,
    type,
    required: value.required === true,
    placeholder: normalizeRegistrationText(value.placeholder, 300) || undefined,
    helpText: normalizeRegistrationText(value.helpText, 1_000) || undefined,
    options: ["single_choice", "multiple_choice", "select", "radio", "checkbox"].includes(type)
      ? options
      : undefined,
    min: finiteNumber(value.min),
    max: finiteNumber(value.max),
    maxLength: maxLength === undefined ? undefined : Math.max(1, Math.min(MAX_TEXT, Math.floor(maxLength))),
    sensitive: value.sensitive === true,
  };
}

export function normalizeRegistrationForm(value: unknown): RegistrationForm | null {
  if (!isRecord(value)) return null;
  const id = normalizeRegistrationId(value.id);
  const activityId = normalizeRegistrationId(value.activityId);
  const title = normalizeRegistrationText(value.title, 200);
  if (!id || !activityId || !title) return null;
  const rawFields = Array.isArray(value.fields) ? value.fields.slice(0, MAX_FIELDS) : [];
  const used = new Set<string>();
  const fields = rawFields.flatMap((item, index) => {
    const field = normalizeRegistrationField(item, index);
    if (!field || used.has(field.id)) return [];
    used.add(field.id);
    return [field];
  });
  const status: RegistrationFormStatus = ["draft", "open", "closed"].includes(String(value.status))
    ? (value.status as RegistrationFormStatus)
    : "draft";
  return {
    id,
    activityId,
    title,
    description: normalizeRegistrationText(value.description, 5_000),
    status,
    fields,
    submitLabel: normalizeRegistrationText(value.submitLabel, 80) || undefined,
    confirmationMessage: normalizeRegistrationText(value.confirmationMessage, 1_000) || undefined,
    createdAt: normalizeRegistrationText(value.createdAt, 40) || new Date(0).toISOString(),
    updatedAt: normalizeRegistrationText(value.updatedAt, 40) || undefined,
    privacyNotice: normalizeRegistrationText(value.privacyNotice, 5_000),
    slug: normalizeRegistrationId(value.slug) || undefined,
    version: finiteNumber(value.version),
  };
}

function answerIsEmpty(answer: RegistrationAnswer) {
  return answer === null || answer === "" || (Array.isArray(answer) && answer.length === 0) || answer === false;
}

function normalizeAnswer(field: RegistrationField, value: unknown): RegistrationAnswer {
  switch (field.type) {
    case "checkbox":
      if (field.options?.length) {
        const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
        const allowed = new Set(field.options);
        return Array.from(new Set(raw.map((item) => normalizeRegistrationText(item, 200)))).filter(
          (item) => allowed.has(item),
        );
      }
      return value === true || value === "true" || value === "on" || value === "1";
    case "multiple_choice": {
      const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
      const allowed = new Set(field.options ?? []);
      return Array.from(new Set(raw.map((item) => normalizeRegistrationText(item, 200)))).filter(
        (item) => allowed.has(item),
      );
    }
    case "number": {
      const text = normalizeRegistrationText(value, 100);
      if (!text) return null;
      const number = Number(text);
      return Number.isFinite(number) ? number : null;
    }
    case "email":
      return normalizeRegistrationEmail(value);
    case "phone":
    case "tel":
      return normalizeRegistrationPhone(value);
    default:
      return normalizeRegistrationText(value, field.maxLength ?? MAX_TEXT);
  }
}

export function validateRegistrationSubmission(
  form: RegistrationForm,
  rawAnswers: unknown,
): SubmissionValidation {
  const input = isRecord(rawAnswers) ? rawAnswers : {};
  const answers: Record<string, RegistrationAnswer> = {};
  const fieldErrors: Record<string, string> = {};
  for (const field of form.fields) {
    const answer = normalizeAnswer(field, input[field.id]);
    answers[field.id] = answer;
    if (field.required && answerIsEmpty(answer)) {
      fieldErrors[field.id] = "此欄位為必填";
      continue;
    }
    if (answerIsEmpty(answer)) continue;
    if (field.type === "email" && (typeof answer !== "string" || !emailPattern.test(answer))) {
      fieldErrors[field.id] = "請輸入有效的電子郵件地址";
    } else if (["phone", "tel"].includes(field.type) && (typeof answer !== "string" || !phonePattern.test(answer))) {
      fieldErrors[field.id] = "請輸入有效的電話號碼";
    } else if (field.type === "date" && (typeof answer !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(answer))) {
      fieldErrors[field.id] = "請選擇有效日期";
    } else if (["single_choice", "select", "radio"].includes(field.type) && !field.options?.includes(String(answer))) {
      fieldErrors[field.id] = "請選擇清單中的選項";
    } else if (field.type === "number") {
      if (typeof answer !== "number") fieldErrors[field.id] = "請輸入有效數字";
      else if (field.min !== undefined && answer < field.min) fieldErrors[field.id] = `不得小於 ${field.min}`;
      else if (field.max !== undefined && answer > field.max) fieldErrors[field.id] = `不得大於 ${field.max}`;
    }
  }
  return Object.keys(fieldErrors).length
    ? { ok: false, answers, fieldErrors }
    : { ok: true, answers, fieldErrors: {} };
}

export function normalizeRegistrationSubmission(
  form: RegistrationForm,
  value: unknown,
): RegistrationSubmission | null {
  if (!isRecord(value)) return null;
  if (value.consent !== true) return null;
  const validation = validateRegistrationSubmission(form, value.answers);
  if (!validation.ok) return null;
  const id = normalizeRegistrationId(value.id);
  if (!id) return null;
  const status: RegistrationSubmissionStatus = ["submitted", "confirmed", "cancelled"].includes(
    String(value.status),
  )
    ? (value.status as RegistrationSubmissionStatus)
    : "submitted";
  return {
    id,
    formId: form.id,
    activityId: form.activityId,
    answers: validation.answers,
    consent: true,
    status,
    paymentStatus: ["unpaid", "checking", "paid", "refunded", "not_required"].includes(String(value.paymentStatus))
      ? (value.paymentStatus as RegistrationPaymentStatus)
      : "unpaid",
    paymentNote: normalizeRegistrationText(value.paymentNote, 1_000) || undefined,
    reminderFiveDaysSentAt: normalizeRegistrationText(value.reminderFiveDaysSentAt, 40) || undefined,
    reminderOneDaySentAt: normalizeRegistrationText(value.reminderOneDaySentAt, 40) || undefined,
    submittedAt: normalizeRegistrationText(value.submittedAt, 40) || new Date(0).toISOString(),
    updatedAt: normalizeRegistrationText(value.updatedAt, 40) || undefined,
  };
}
