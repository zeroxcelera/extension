/**
 * A rough strength label for a new vault password, from length and character variety
 * only (no dictionary). The vault is encrypted with Argon2id, but a short or common
 * password can still be guessed offline by anyone who copies the encrypted vault.
 */
export function passwordStrength(password: string): 'weak' | 'fair' | 'strong' {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  const words = password.trim().split(/\s+/).filter(Boolean).length;
  if (password.length >= 16 || (words >= 4 && password.length >= 14)) return 'strong';
  if (password.length >= 12 && classes >= 3) return 'strong';
  if (password.length >= 12 || (password.length >= 10 && classes >= 3)) return 'fair';
  return 'weak';
}
