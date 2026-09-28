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
  image?: string;
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
  image?: string;
  status: RegistrationFormStatus;
  owner?: string;
  proxy?: string;
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
export const REGISTRATION_ARTICLE_LIMIT = 20_000;
export const REGISTRATION_IMAGE_BYTES = 256 * 1024;
export const REGISTRATION_IMAGES_TOTAL_BYTES = 1024 * 1024;
export const REGISTRATION_REQUEST_LIMIT = 2_000_000;

/** Only bounded raster data URLs can be stored or rendered. Never accept remote URLs or SVG. */
export function registrationImageBytes(value: unknown): number | null {
  if (typeof value !== "string" || value.length > Math.ceil(REGISTRATION_IMAGE_BYTES / 3) * 4 + 40) return null;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4) return null;
  try {
    const bytes = atob(match[2]);
    if (!bytes.length || bytes.length > REGISTRATION_IMAGE_BYTES || btoa(bytes) !== match[2]) return null;
    const signature = (start: number, codes: number[]) => codes.every((code, index) => bytes.charCodeAt(start + index) === code);
    const uint32 = (start: number, littleEndian = false) => [0,1,2,3].reduce((number, index) => number + bytes.charCodeAt(start + index) * 2 ** (8 * (littleEndian ? index : 3 - index)), 0);
    const valid = match[1] === "png" ? bytes.length >= 45 && signature(0, [137,80,78,71,13,10,26,10]) && uint32(8) === 13 && bytes.slice(12,16) === "IHDR" && uint32(16) > 0 && uint32(20) > 0 && uint32(16) * uint32(20) <= 40_000_000 && signature(bytes.length - 12, [0,0,0,0,73,69,78,68,174,66,96,130])
      : match[1] === "jpeg" ? bytes.length >= 4 && signature(0, [255,216,255]) && signature(bytes.length - 2, [255,217])
      : bytes.length >= 20 && bytes.slice(0,4) === "RIFF" && uint32(4, true) === bytes.length - 8 && bytes.slice(8,12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(bytes.slice(12,16));
    return valid ? bytes.length : null;
  } catch { return null; }
}

export function registrationPresentationError(value: unknown): string | null {
  if (!isRecord(value)) return "表單資料格式錯誤";
  const fields = Array.isArray(value.fields) ? value.fields : [];
  let total = 0;
  for (const item of [value, ...fields]) {
    if (!isRecord(item)) continue;
    if (item.image !== undefined && item.image !== "") {
      const bytes = registrationImageBytes(item.image);
      if (bytes === null) return "圖片僅支援有效的 PNG、JPEG 或 WebP，每張上限 256 KB";
      total += bytes;
    }
  }
  if (total > REGISTRATION_IMAGES_TOTAL_BYTES) return "整份表單圖片合計不得超過 1 MB，請減少圖片或縮小圖片";
  for (const key of ["description", "privacyNotice"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > REGISTRATION_ARTICLE_LIMIT)) return "表單說明與個資告知各不得超過 20,000 字";
  }
  if (fields.some((field) => isRecord(field) && field.helpText !== undefined && (typeof field.helpText !== "string" || field.helpText.length > MAX_TEXT))) return "問題詳細說明不得超過 10,000 字";
  return null;
}

export function registrationAnswerStructure(fields: RegistrationField[]) {
  return fields.map((field) => { const structure = { ...field }; delete structure.image; delete structure.helpText; return structure; });
}
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
    helpText: normalizeRegistrationText(value.helpText, MAX_TEXT) || undefined,
    image: registrationImageBytes(value.image) !== null ? value.image as string : undefined,
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
    description: normalizeRegistrationText(value.description, REGISTRATION_ARTICLE_LIMIT),
    image: registrationImageBytes(value.image) !== null ? value.image as string : undefined,
    status,
    owner: normalizeRegistrationText(value.owner, 100) || undefined,
    proxy: normalizeRegistrationText(value.proxy, 100) || undefined,
    fields,
    submitLabel: normalizeRegistrationText(value.submitLabel, 80) || undefined,
    confirmationMessage: normalizeRegistrationText(value.confirmationMessage, 1_000) || undefined,
    createdAt: normalizeRegistrationText(value.createdAt, 40) || new Date(0).toISOString(),
    updatedAt: normalizeRegistrationText(value.updatedAt, 40) || undefined,
    privacyNotice: normalizeRegistrationText(value.privacyNotice, REGISTRATION_ARTICLE_LIMIT),
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
