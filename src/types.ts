export type Role = 'ADMIN' | 'OPERATOR' | 'VIEWER'

export type Bindings = {
  DB: D1Database
  R2?: R2Bucket
  APP_ENV?: string
  CONNECTOR_KEY_ID?: string
  MAX_REVISION_ROUNDS?: string
  // Secrets (runtime secret store only — never committed)
  CONNECTOR_HMAC_SECRET?: string
  CONNECTOR_HMAC_SECRET_PREVIOUS?: string
  CUSTOMER_TOKEN_SECRET?: string
  DOWNLOAD_SIGNING_SECRET?: string
}

export type OperatorCtx = {
  id: string
  email: string
  display_name: string
  role: Role
}

export type InputValue = string | File | (string | File)[]
export type Input = Record<string, InputValue | unknown>

export type Variables = {
  cid: string
  operator?: OperatorCtx
  csrf?: string
  input?: Input
  connectorKeyId?: string
  bodyText?: string
}

export type AppEnv = { Bindings: Bindings; Variables: Variables }

export type Actor = { type: 'OPERATOR' | 'CONNECTOR' | 'SYSTEM'; id: string }
