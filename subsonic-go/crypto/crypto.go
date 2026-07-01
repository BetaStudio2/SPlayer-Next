package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// 兼容 TS 层 encryptString/decryptString 的 AES-256-GCM 解密
// 密文格式: enc:v1:<iv_hex>:<tag_hex>:<ct_hex>

const prefix = "enc:v1:"

var cachedKey []byte

// LoadKey 从环境变量或 secret.key 文件加载 32 字节密钥
func LoadKey() ([]byte, error) {
	if cachedKey != nil {
		return cachedKey, nil
	}

	// 1. 环境变量优先（hex 编码）
	if envKey := os.Getenv("SPLAYER_SECRET_KEY"); envKey != "" {
		if len(envKey) == 64 {
			key, err := hex.DecodeString(envKey)
			if err == nil {
				cachedKey = key
				return key, nil
			}
		}
		// 非 hex：用 scrypt 派生（与 TS 一致）
		// 简化：此处只支持 hex，scrypt 场景生产环境不推荐
		return nil, fmt.Errorf("SPLAYER_SECRET_KEY must be 64-char hex")
	}

	// 2. 密钥文件
	dataDir := os.Getenv("SPLAYER_DATA_DIR")
	if dataDir == "" {
		wd, err := os.Getwd()
		if err != nil {
			dataDir = filepath.Join(".", "data")
		} else {
			dataDir = filepath.Join(wd, "data")
		}
	}
	keyPath := filepath.Join(dataDir, "secret.key")
	raw, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, fmt.Errorf("read secret.key: %w", err)
	}
	if len(raw) != 32 {
		return nil, fmt.Errorf("secret.key length %d, expected 32", len(raw))
	}
	cachedKey = raw
	return raw, nil
}

// DecryptString 解密 enc:v1:<iv>:<tag>:<ct> 格式的密文
// 非加密格式（明文存量数据）原样返回（向后兼容）
func DecryptString(ciphertext string) (string, error) {
	if ciphertext == "" {
		return "", nil
	}
	if !strings.HasPrefix(ciphertext, prefix) {
		// 明文存量数据
		return ciphertext, nil
	}

	rest := ciphertext[len(prefix):]
	parts := strings.SplitN(rest, ":", 3)
	if len(parts) != 3 {
		return "", fmt.Errorf("invalid ciphertext format")
	}

	iv, err := hex.DecodeString(parts[0])
	if err != nil {
		return "", fmt.Errorf("decode iv: %w", err)
	}
	tag, err := hex.DecodeString(parts[1])
	if err != nil {
		return "", fmt.Errorf("decode tag: %w", err)
	}
	ct, err := hex.DecodeString(parts[2])
	if err != nil {
		return "", fmt.Errorf("decode ct: %w", err)
	}

	key, err := LoadKey()
	if err != nil {
		return "", err
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}

	// Go GCM expects tag appended to ciphertext
	combined := append(ct, tag...)
	plaintext, err := gcm.Open(nil, iv, combined, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt: %w", err)
	}
	return string(plaintext), nil
}
