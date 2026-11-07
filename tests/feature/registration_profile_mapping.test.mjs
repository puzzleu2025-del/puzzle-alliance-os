import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRegistrationField, normalizeRegistrationForm, registrationAnswerStructure,
  registrationPresentationError, registrationProfileMappingError,
  isRegistrationProfileMappingCompatible, registrationProfileKeys,
} from "../../app/registration-types.ts";

const field = (id, type, profileKey) => ({
  id, label: id, type, required: false, ...(profileKey === undefined ? {} : { profileKey, sensitive: true }),
});
const form = (fields) => ({
  id: "form1", activityId: "activity1", title: "Activity", status: "open",
  description: "Description", privacyNotice: "Notice", fields,
});

test("legacy fields stay unmapped and save without adding mapping or guessing names", () => {
  const legacy = form([
    { id: "email", label: "電子郵件", type: "email", required: true, sensitive: true },
    { id: "name", label: "姓名", type: "short_text", required: true },
    { id: "phone", label: "電話", type: "tel", required: false },
  ]);
  const normalized = normalizeRegistrationForm(legacy);
  assert.ok(normalized);
  assert.ok(normalized.fields.every((row) => !Object.hasOwn(row, "profileKey")));
  assert.ok(!JSON.stringify(normalized).includes("profileKey"));
  assert.equal(registrationPresentationError(legacy), null);
  const roundTrip = normalizeRegistrationForm(JSON.parse(JSON.stringify(normalized)));
  assert.deepEqual(roundTrip, normalized);
  assert.deepEqual(registrationAnswerStructure(roundTrip.fields), registrationAnswerStructure(normalized.fields));
});

test("explicit profile mappings preserve only compatible field types", () => {
  const examples = [
    ["displayName", "short_text"], ["displayName", "text"], ["email", "email"],
    ["email", "short_text"], ["email", "text"], ["phone", "phone"], ["phone", "tel"],
    ["phone", "short_text"], ["organization", "short_text"], ["position", "text"],
  ];
  for (const [key, type] of examples) {
    assert.equal(isRegistrationProfileMappingCompatible(type, key), true);
    const normalized = normalizeRegistrationField(field("f1", type, key));
    assert.equal(normalized.profileKey, key);
    assert.equal(registrationPresentationError(form([field("f1", type, key)])), null);
  }
  assert.deepEqual(registrationProfileKeys, ["displayName", "email", "phone", "organization", "position"]);
});

test("unknown or incompatible mappings are rejected rather than silently remapped", () => {
  for (const [type, key] of [
    ["email", "phone"], ["phone", "email"], ["number", "displayName"],
    ["long_text", "organization"], ["single_choice", "position"],
    ["short_text", "unknown"], ["short_text", null], ["short_text", ""],
  ]) {
    const raw = field("f1", type, key);
    assert.equal(registrationProfileMappingError([raw]), "個人資料對應與回答方式不相容");
    assert.equal(registrationPresentationError(form([raw])), "個人資料對應與回答方式不相容");
    assert.equal(normalizeRegistrationField(raw), null);
    assert.equal(normalizeRegistrationForm(form([raw])), null);
  }
});

test("duplicate mapping is rejected even when both fields have compatible types", () => {
  const duplicate = [field("first", "short_text", "email"), field("second", "email", "email")];
  assert.equal(registrationProfileMappingError(duplicate), "同一項個人資料只能對應一個問題");
  assert.equal(registrationPresentationError(form(duplicate)), "同一項個人資料只能對應一個問題");
  assert.equal(normalizeRegistrationForm(form(duplicate)), null);
  assert.ok(normalizeRegistrationForm(form([field("first", "short_text", "email"), field("second", "email")])));
});

test("mapped fields must be sensitive even when submitted outside the editor", () => {
  for (const sensitive of [false, undefined, null, "true"]) {
    const raw = { ...field("email", "email", "email"), sensitive };
    assert.equal(registrationProfileMappingError([raw]), "對應個人資料的問題必須標記為個資");
    assert.equal(registrationPresentationError(form([raw])), "對應個人資料的問題必須標記為個資");
    assert.equal(normalizeRegistrationField(raw), null);
    assert.equal(normalizeRegistrationForm(form([raw])), null);
  }
  const legacy = { id: "legacy", label: "Email", type: "email", required: false, sensitive: false };
  assert.equal(normalizeRegistrationForm(form([legacy])).fields[0].sensitive, false);
});

test("mapping participates in existing locked answer structure; help/image stay presentation-only", () => {
  const original = normalizeRegistrationForm(form([field("f1", "short_text")])).fields;
  const mapped = normalizeRegistrationForm(form([field("f1", "short_text", "displayName")])).fields;
  assert.notDeepEqual(registrationAnswerStructure(mapped), registrationAnswerStructure(original));
  assert.deepEqual(
    registrationAnswerStructure([{ ...mapped[0], helpText: "説明", image: "image" }]),
    registrationAnswerStructure(mapped),
  );
  assert.deepEqual(
    registrationAnswerStructure(normalizeRegistrationForm(form([field("f1", "short_text", undefined)])).fields),
    registrationAnswerStructure(original),
  );
});
