declare namespace Cloudflare {
  interface Env {
    DB: D1Database
  }
}

declare module '*?raw' {
  const text: string
  export default text
}
