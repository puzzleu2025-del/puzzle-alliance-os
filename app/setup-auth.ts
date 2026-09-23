// The Sites access gateway injects this header after authenticating a visitor.
// The value identifies this Site's owner; it is an identifier, not a password.
export const SITE_OWNER_USER_ID = "1f55f57e-cf3e-4815-806d-e19aa7b344a9";

export function isSiteOwner(requestHeaders: Headers) {
  return requestHeaders.get("oai-authenticated-user-id") === SITE_OWNER_USER_ID;
}
