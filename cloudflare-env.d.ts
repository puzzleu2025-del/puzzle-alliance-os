declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    INITIAL_ADMIN_PASSWORD?: string;
  }
}
