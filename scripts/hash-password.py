import getpass
import secrets
import hashlib


def main() -> None:
    password = getpass.getpass("Digite uma senha compartilhada forte (mínimo de 12 caracteres): ")
    if len(password) < 12:
        raise SystemExit("A senha precisa ter pelo menos 12 caracteres.")
    salt = secrets.token_bytes(16)
    password_hash = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=2**14,
        r=8,
        p=1,
        dklen=64,
        maxmem=128 * 1024 * 1024,
    )
    session_secret = secrets.token_hex(32)
    print(f"APP_PASSWORD_HASH=scrypt${salt.hex()}${password_hash.hex()}")
    print(f"SESSION_SECRET={session_secret}")


if __name__ == "__main__":
    main()
