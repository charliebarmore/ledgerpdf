export function notaryCredentials(env = process.env) {
  if (env.APPLE_KEYCHAIN_PROFILE) {
    return ['--keychain-profile', env.APPLE_KEYCHAIN_PROFILE]
  }
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) {
    return [
      '--key', env.APPLE_API_KEY,
      '--key-id', env.APPLE_API_KEY_ID,
      '--issuer', env.APPLE_API_ISSUER
    ]
  }
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
    return [
      '--apple-id', env.APPLE_ID,
      '--password', env.APPLE_APP_SPECIFIC_PASSWORD,
      '--team-id', env.APPLE_TEAM_ID
    ]
  }
  throw new Error('no complete macOS notarization credential set')
}
