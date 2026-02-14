/**
 * 加密工具模块
 *
 * 使用 Node.js crypto 模块替代 Electron safeStorage 进行 API Key 加密。
 * 采用 AES-256-GCM 算法，提供与 safeStorage 相同级别的安全性。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16

// 从环境变量获取加密密钥，如果没有则使用默认密钥（开发环境）
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'proma-web-default-encryption-key'
const SALT = 'proma-salt-v1'

// 使用 scrypt 派生固定长度的密钥
const KEY = scryptSync(ENCRYPTION_KEY, SALT, 32)

/**
 * 加密文本
 *
 * @param text 明文
 * @returns 格式: iv:authTag:encrypted（均为 hex 编码）
 */
export function encrypt(text: string): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, KEY, iv)

  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')

  const authTag = cipher.getAuthTag()

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`
}

/**
 * 解密文本
 *
 * @param encrypted 格式: iv:authTag:encrypted
 * @returns 明文
 */
export function decrypt(encrypted: string): string {
  const parts = encrypted.split(':')
  if (parts.length !== 3) {
    throw new Error('无效的加密数据格式')
  }

  const [ivHex, authTagHex, data] = parts
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')

  const decipher = createDecipheriv(ALGORITHM, KEY, iv)
  decipher.setAuthTag(authTag)

  let decrypted = decipher.update(data, 'hex', 'utf8')
  decrypted += decipher.final('utf8')

  return decrypted
}

/**
 * 检查加密是否可用
 *
 * 在 Web 版本中，加密始终可用（不依赖操作系统）
 */
export function isEncryptionAvailable(): boolean {
  return true
}
