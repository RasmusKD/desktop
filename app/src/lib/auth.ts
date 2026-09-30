import { Account } from '../models/account'

/** Get the auth key for the user. */
export function getKeyForAccount(account: Account): string {
  return getKeyForEndpoint(account.endpoint)
}

/** Get the auth key for the endpoint. */
export function getKeyForEndpoint(endpoint: string): string {
  // A renamed build keeps its own credential entry: sharing the official
  // app's key lets one app's sign-in overwrite the other's token, and a token
  // from a different OAuth app can lack access the other app was granted.
  const appName = __DEV__
    ? 'GitHub Desktop Dev'
    : __APP_NAME__ === 'GitHub Desktop'
    ? 'GitHub'
    : __APP_NAME__

  return `${appName} - ${endpoint}`
}
