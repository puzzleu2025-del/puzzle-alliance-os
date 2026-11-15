declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    INITIAL_ADMIN_PASSWORD?: string;
    // Participant Google sign-in. Values are deployment secrets; never commit them.
    PARTICIPANT_ENABLED?: string;
    PARTICIPANT_ORIGIN?: string;
    PARTICIPANT_GOOGLE_CLIENT_ID?: string;
    PARTICIPANT_GOOGLE_CLIENT_SECRET?: string;
    PARTICIPANT_TERMS_VERSION?: string;
    PARTICIPANT_TRUST_CLOUDFLARE_EDGE?: string;
  }
}
