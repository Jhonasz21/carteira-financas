from __future__ import annotations

import hashlib
import hmac
import json
import logging
import math
import os
import re
import secrets
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterator
from urllib.parse import urlsplit

import mysql.connector
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from mysql.connector import MySQLConnection

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("meu_pluxee")

SESSION_MAX_AGE = timedelta(days=14)
LOGIN_WINDOW_SECONDS = 15 * 60
MAX_LOGIN_ATTEMPTS = 5
MAX_REQUEST_BYTES = 6_000_000
DEFAULT_ACCOUNT_IDS = {"alimentacao-1", "alimentacao-2", "refeicao-1"}
CUSTOM_ACCOUNT_ID = re.compile(
    r"^card-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$", re.IGNORECASE
)
TRANSACTION_ID = re.compile(r"^[a-f0-9-]{36}$", re.IGNORECASE)

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


class ConfigurationError(Exception):
    pass


def configuration() -> dict[str, Any]:
    required = (
        "APP_ORIGIN",
        "APP_PASSWORD_HASH",
        "SESSION_SECRET",
        "DB_HOST",
        "DB_NAME",
        "DB_USER",
        "DB_PASSWORD",
    )
    values = {name: os.environ.get(name, "") for name in required}
    if any(not value for value in values.values()):
        raise ConfigurationError("Configure todas as variáveis de ambiente obrigatórias.")
    if not re.fullmatch(r"scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}", values["APP_PASSWORD_HASH"], re.I):
        raise ConfigurationError("APP_PASSWORD_HASH tem um formato inválido.")
    if not re.fullmatch(r"[a-f0-9]{64}", values["SESSION_SECRET"], re.I):
        raise ConfigurationError("SESSION_SECRET deve conter 32 bytes em hexadecimal.")
    origin = urlsplit(values["APP_ORIGIN"])
    try:
        valid_origin = (
            origin.scheme == "https"
            and bool(origin.hostname)
            and not origin.path
            and not origin.query
            and not origin.fragment
            and origin.username is None
            and origin.password is None
            and origin.port != 0
        )
    except ValueError:
        valid_origin = False
    if not valid_origin:
        raise ConfigurationError("APP_ORIGIN deve ser a origem HTTPS exata do site.")
    try:
        values["DB_PORT"] = int(os.environ.get("DB_PORT", "3306"))
    except ValueError as error:
        raise ConfigurationError("DB_PORT deve ser um número válido.") from error
    values["FIREBASE_CREDENTIALS_PATH"] = os.environ.get("FIREBASE_CREDENTIALS_PATH", "")
    return values


@contextmanager
def database(config: dict[str, Any]) -> Iterator[MySQLConnection]:
    connection = mysql.connector.connect(
        host=config["DB_HOST"],
        port=config["DB_PORT"],
        database=config["DB_NAME"],
        user=config["DB_USER"],
        password=config["DB_PASSWORD"],
        charset="utf8mb4",
        autocommit=False,
        connection_timeout=10,
    )
    try:
        yield connection
    finally:
        if connection.is_connected():
            connection.close()


def json_response(status: int, body: dict[str, Any]) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content=body,
        headers={
            "Cache-Control": "no-store, private",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        },
    )


def error_response(status: int, message: str) -> JSONResponse:
    return json_response(status, {"error": message})


def check_origin(request: Request, config: dict[str, Any]) -> bool:
    return request.headers.get("origin") == config["APP_ORIGIN"]


def bearer_token(request: Request) -> str:
    authorization = request.headers.get("authorization", "")
    scheme, _, token = authorization.partition(" ")
    return token if scheme.lower() == "bearer" else ""


def get_session(connection: MySQLConnection, token: str) -> dict[str, str] | None:
    if not token or len(token) > 128:
        return None
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    cursor = connection.cursor(dictionary=True)
    try:
        cursor.execute(
            "SELECT csrf_token FROM meu_pluxee_sessions "
            "WHERE token_hash = %s AND expires_at > UTC_TIMESTAMP()",
            (token_hash,),
        )
        return cursor.fetchone()
    finally:
        cursor.close()


def csrf_matches(request: Request, session: dict[str, str] | None) -> bool:
    provided = request.headers.get("x-csrf-token", "")
    expected = session["csrf_token"] if session else ""
    return bool(provided and expected and hmac.compare_digest(provided, expected))


async def read_json(request: Request, maximum_bytes: int = MAX_REQUEST_BYTES) -> dict[str, Any] | JSONResponse:
    try:
        raw = await request.body()
        if len(raw) > maximum_bytes:
            return error_response(413, "A requisição excede o limite de tamanho.")
        body = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return error_response(400, "O JSON enviado é inválido.")
    if not isinstance(body, dict):
        return error_response(400, "O corpo da requisição deve ser um objeto JSON.")
    return body


def valid_number(value: Any, *, allow_zero: bool) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and (value >= 0 if allow_zero else value > 0)
        and value <= 1_000_000_000
    )


def valid_text(value: Any, maximum_length: int) -> bool:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > maximum_length:
        return False
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def validate_state(value: Any) -> dict[str, Any] | JSONResponse:
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("accounts"), list)
        or not isinstance(value.get("transactions"), list)
        or not 1 <= len(value["accounts"]) <= 100
        or len(value["transactions"]) > 100_000
    ):
        return error_response(422, "A estrutura do cadastro de cartões ou do extrato é inválida.")

    account_ids: set[str] = set()
    account_names: set[str] = set()
    accounts = []
    for account in value["accounts"]:
        if not isinstance(account, dict):
            return error_response(422, "Há um cartão inválido nos dados enviados.")
        account_id = account.get("id")
        name = account.get("name")
        kind = account.get("kind")
        opening_balance = account.get("openingBalance")
        daily_limit = account.get("dailyLimit")
        last_four_digits = account.get("lastFourDigits", "")
        custom = account.get("custom", False)
        is_custom = isinstance(account_id, str) and account_id.startswith("card-")
        if (
            not isinstance(account_id, str)
            or not (account_id in DEFAULT_ACCOUNT_IDS or CUSTOM_ACCOUNT_ID.fullmatch(account_id))
            or account_id in account_ids
            or not valid_text(name, 35)
            or kind not in ("food", "meal")
            or not valid_number(opening_balance, allow_zero=True)
            or not valid_number(daily_limit, allow_zero=True)
            or not isinstance(last_four_digits, str)
            or (last_four_digits and not re.fullmatch(r"\d{4}", last_four_digits))
            or not isinstance(custom, bool)
            or custom != is_custom
        ):
            return error_response(422, "Confira o nome, o tipo, o saldo e a identificação dos cartões.")
        normalized_name = name.strip().casefold()
        if normalized_name in account_names:
            return error_response(422, "Os nomes dos cartões precisam ser diferentes.")
        account_ids.add(account_id)
        account_names.add(normalized_name)
        accounts.append(
            {
                "id": account_id,
                "name": name.strip(),
                "kind": kind,
                "openingBalance": round(opening_balance, 2),
                "dailyLimit": round(daily_limit, 2),
                "lastFourDigits": last_four_digits,
                "custom": custom,
            }
        )

    transactions = []
    transaction_ids: set[str] = set()
    for transaction in value["transactions"]:
        if not isinstance(transaction, dict):
            return error_response(422, "Há um lançamento inválido no extrato.")
        transaction_id = transaction.get("id")
        account_id = transaction.get("accountId")
        kind = transaction.get("kind")
        description = transaction.get("description")
        amount = transaction.get("amount")
        transaction_date = transaction.get("date")
        try:
            valid_transaction_date = (
                isinstance(transaction_date, str)
                and date.fromisoformat(transaction_date).isoformat() == transaction_date
            )
        except ValueError:
            valid_transaction_date = False
        if (
            not isinstance(transaction_id, str)
            or not TRANSACTION_ID.fullmatch(transaction_id)
            or transaction_id in transaction_ids
            or not isinstance(account_id, str)
            or account_id not in account_ids
            or kind not in ("expense", "purchase")
            or not valid_text(description, 60)
            or not valid_number(amount, allow_zero=False)
            or not valid_transaction_date
        ):
            return error_response(422, "Confira a data, o valor, a descrição e o cartão de cada lançamento.")
        transaction_ids.add(transaction_id)
        transactions.append(
            {
                "id": transaction_id,
                "accountId": account_id,
                "kind": kind,
                "description": description.strip(),
                "amount": round(amount, 2),
                "date": transaction_date,
            }
        )
    return {"accounts": accounts, "transactions": transactions}


def verify_password(password: Any, encoded_hash: str) -> bool:
    if not isinstance(password, str) or not password:
        return False
    try:
        encoded_password = password.encode("utf-8")
    except UnicodeEncodeError:
        return False
    if len(encoded_password) > 1024:
        return False
    _, salt_hex, expected_hex = encoded_hash.split("$")
    derived = hashlib.scrypt(
        encoded_password,
        salt=bytes.fromhex(salt_hex),
        n=2**14,
        r=8,
        p=1,
        dklen=64,
        maxmem=128 * 1024 * 1024,
    )
    return hmac.compare_digest(derived, bytes.fromhex(expected_hex))


def login_limit_key(request: Request, config: dict[str, Any]) -> str:
    secret = bytes.fromhex(config["SESSION_SECRET"])
    ip_address = request.client.host if request.client else "unknown"
    return hmac.new(secret, f"login:{ip_address}".encode(), hashlib.sha256).hexdigest()


def login_limited(connection: MySQLConnection, key: str) -> bool:
    cursor = connection.cursor(dictionary=True)
    try:
        cursor.execute(
            "DELETE FROM meu_pluxee_login_attempts "
            "WHERE started_at < UTC_TIMESTAMP() - INTERVAL 1 DAY"
        )
        cursor.execute(
            "DELETE FROM meu_pluxee_sessions WHERE expires_at < UTC_TIMESTAMP()"
        )
        cursor.execute(
            "INSERT IGNORE INTO meu_pluxee_login_attempts (key_hash, started_at, attempts) "
            "VALUES (%s, UTC_TIMESTAMP(), 0)",
            (key,),
        )
        connection.commit()
        cursor.execute(
            "SELECT started_at, attempts FROM meu_pluxee_login_attempts "
            "WHERE key_hash = %s FOR UPDATE",
            (key,),
        )
        record = cursor.fetchone()
        if not record:
            raise RuntimeError("Não foi possível verificar o limite de tentativas.")
        expired = (datetime.now(timezone.utc).replace(tzinfo=None) - record["started_at"]).total_seconds() >= LOGIN_WINDOW_SECONDS
        if expired:
            cursor.execute(
                "UPDATE meu_pluxee_login_attempts SET started_at = UTC_TIMESTAMP(), attempts = 0 "
                "WHERE key_hash = %s",
                (key,),
            )
            connection.commit()
            return False
        return record["attempts"] >= MAX_LOGIN_ATTEMPTS
    finally:
        cursor.close()


def record_failed_login(connection: MySQLConnection, key: str) -> None:
    cursor = connection.cursor()
    try:
        cursor.execute(
            "UPDATE meu_pluxee_login_attempts "
            "SET attempts = attempts + 1 WHERE key_hash = %s",
            (key,),
        )
        connection.commit()
    finally:
        cursor.close()


def state_response(connection: MySQLConnection) -> dict[str, Any]:
    cursor = connection.cursor(dictionary=True)
    try:
        cursor.execute("SELECT revision, payload FROM pluxee_shared_state WHERE id = 1")
        row = cursor.fetchone()
        if not row:
            raise RuntimeError("A tabela pluxee_shared_state não foi inicializada.")
        payload = json.loads(row["payload"]) if row["payload"] is not None else None
        return {"state": payload, "revision": int(row["revision"])}
    finally:
        cursor.close()


def firebase_messaging(config: dict[str, Any]) -> Any:
    credentials_path = config["FIREBASE_CREDENTIALS_PATH"]
    if not credentials_path:
        raise ConfigurationError("Configure FIREBASE_CREDENTIALS_PATH para ativar o Firebase.")

    import firebase_admin
    from firebase_admin import credentials, messaging

    try:
        firebase_app = firebase_admin.get_app()
    except ValueError:
        firebase_app = firebase_admin.initialize_app(
            credentials.Certificate(credentials_path)
        )
    return messaging, firebase_app


def send_fcm_update(
    connection: MySQLConnection,
    config: dict[str, Any],
    transaction: dict[str, Any],
    account_name: str,
    additional_count: int,
) -> str:
    if not config["FIREBASE_CREDENTIALS_PATH"]:
        return "unconfigured"

    try:
        cursor = connection.cursor(dictionary=True)
        try:
            cursor.execute(
                "SELECT token_hash, registration_token FROM meu_pluxee_fcm_tokens"
            )
            registrations = cursor.fetchall()
        finally:
            cursor.close()
        if not registrations:
            return "no_subscribers"

        messaging, firebase_app = firebase_messaging(config)
        message_data = {
            "kind": transaction["kind"],
            "description": transaction["description"],
            "amount": str(transaction["amount"]),
            "date": transaction["date"],
            "account": account_name,
            "additionalCount": str(additional_count),
        }
        success_count = 0
        invalid_hashes = []
        for start in range(0, len(registrations), 500):
            batch = registrations[start : start + 500]
            response = messaging.send_each_for_multicast(
                messaging.MulticastMessage(
                    data=message_data,
                    tokens=[record["registration_token"] for record in batch],
                ),
                app=firebase_app,
            )
            success_count += response.success_count
            for record, result in zip(batch, response.responses):
                if result.success:
                    continue
                if isinstance(result.exception, messaging.UnregisteredError):
                    invalid_hashes.append(record["token_hash"])
                else:
                    logger.error("Falha ao enviar uma notificação Firebase para um aparelho.")
        if invalid_hashes:
            cleanup_cursor = connection.cursor()
            try:
                cleanup_cursor.executemany(
                    "DELETE FROM meu_pluxee_fcm_tokens WHERE token_hash = %s",
                    [(token_hash,) for token_hash in invalid_hashes],
                )
                connection.commit()
            finally:
                cleanup_cursor.close()
        return "sent" if success_count else "failed"
    except Exception:
        logger.exception("Falha ao enviar a notificação Firebase.")
        return "failed"


async def api_handler(request: Request) -> JSONResponse:
    try:
        config = configuration()
        action = request.query_params.get("action", "")
        method = request.method.upper()
        token = bearer_token(request)

        with database(config) as connection:
            session = get_session(connection, token)

            if method == "GET" and action == "session":
                return json_response(
                    200,
                    {
                        "authenticated": session is not None,
                        "csrfToken": session["csrf_token"] if session else secrets.token_urlsafe(32),
                    },
                )

            if method == "POST" and action == "login":
                if not check_origin(request, config):
                    return error_response(403, "A origem desta solicitação não foi autorizada.")
                content_length = request.headers.get("content-length")
                if content_length and content_length.isdigit() and int(content_length) > 4096:
                    return error_response(413, "A requisição excede o limite de tamanho.")
                body = await read_json(request, 4096)
                if isinstance(body, JSONResponse):
                    return body
                key = login_limit_key(request, config)
                if login_limited(connection, key):
                    return error_response(429, "Muitas tentativas de acesso. Aguarde 15 minutos e tente novamente.")
                if not verify_password(body.get("password"), config["APP_PASSWORD_HASH"]):
                    record_failed_login(connection, key)
                    return error_response(401, "Senha incorreta. Confira a senha e tente novamente.")
                access_token = secrets.token_urlsafe(32)
                csrf_token = secrets.token_urlsafe(32)
                cursor = connection.cursor()
                try:
                    cursor.execute(
                        "INSERT INTO meu_pluxee_sessions (token_hash, csrf_token, expires_at) "
                        "VALUES (%s, %s, UTC_TIMESTAMP() + INTERVAL 14 DAY)",
                        (hashlib.sha256(access_token.encode()).hexdigest(), csrf_token),
                    )
                    cursor.execute(
                        "DELETE FROM meu_pluxee_login_attempts WHERE key_hash = %s",
                        (key,),
                    )
                    connection.commit()
                finally:
                    cursor.close()
                return json_response(
                    200,
                    {
                        "authenticated": True,
                        "accessToken": access_token,
                        "csrfToken": csrf_token,
                    },
                )

            if method == "POST" and action == "logout":
                if not check_origin(request, config):
                    return error_response(403, "A origem desta solicitação não foi autorizada.")
                if session is None:
                    return error_response(401, "Sua sessão expirou. Entre novamente.")
                if not csrf_matches(request, session):
                    return error_response(403, "A sessão expirou. Atualize a página e entre novamente.")
                cursor = connection.cursor()
                try:
                    cursor.execute(
                        "DELETE FROM meu_pluxee_sessions WHERE token_hash = %s",
                        (hashlib.sha256(token.encode()).hexdigest(),),
                    )
                    connection.commit()
                finally:
                    cursor.close()
                return json_response(200, {"authenticated": False})

            if action == "fcm-token" and method in ("POST", "DELETE"):
                if not check_origin(request, config):
                    return error_response(403, "A origem desta solicitação não foi autorizada.")
                if session is None:
                    return error_response(401, "Sua sessão expirou. Entre novamente.")
                if not csrf_matches(request, session):
                    return error_response(403, "A sessão expirou. Atualize a página e entre novamente.")
                if not config["FIREBASE_CREDENTIALS_PATH"]:
                    return error_response(503, "O Firebase ainda não foi configurado no servidor.")
                try:
                    firebase_messaging(config)
                except Exception:
                    logger.exception("Não foi possível inicializar o Firebase Admin SDK.")
                    return error_response(503, "Não foi possível inicializar o Firebase no servidor.")

                body = await read_json(request, 8192)
                if isinstance(body, JSONResponse):
                    return body
                registration_token = body.get("token")
                if (
                    not isinstance(registration_token, str)
                    or not 100 <= len(registration_token) <= 4096
                    or not registration_token.isascii()
                    or not re.fullmatch(r"[A-Za-z0-9_:.~/=+\-]+", registration_token)
                ):
                    return error_response(422, "O token de notificações enviado é inválido.")
                token_hash = hashlib.sha256(registration_token.encode("utf-8")).hexdigest()
                cursor = connection.cursor()
                try:
                    if method == "POST":
                        cursor.execute(
                            "INSERT INTO meu_pluxee_fcm_tokens (token_hash, registration_token) "
                            "VALUES (%s, %s) ON DUPLICATE KEY UPDATE "
                            "registration_token = VALUES(registration_token), created_at = CURRENT_TIMESTAMP",
                            (token_hash, registration_token),
                        )
                    else:
                        cursor.execute(
                            "DELETE FROM meu_pluxee_fcm_tokens WHERE token_hash = %s",
                            (token_hash,),
                        )
                    connection.commit()
                finally:
                    cursor.close()
                return json_response(200, {"registered": method == "POST"})

            if method == "GET" and action == "state":
                if session is None:
                    return error_response(401, "Sua sessão expirou. Entre novamente.")
                revision_param = request.query_params.get("revision")
                if revision_param is not None:
                    if len(revision_param) > 16 or not re.fullmatch(r"(?:0|[1-9]\d*)", revision_param):
                        return error_response(400, "A revisão dos dados é inválida. Atualize o aplicativo e tente novamente.")
                    revision = int(revision_param)
                    if revision > 9_007_199_254_740_991:
                        return error_response(400, "A revisão dos dados é inválida. Atualize o aplicativo e tente novamente.")
                    cursor = connection.cursor()
                    try:
                        cursor.execute("SELECT revision FROM pluxee_shared_state WHERE id = 1")
                        current_revision = cursor.fetchone()
                    finally:
                        cursor.close()
                    if current_revision is None:
                        raise RuntimeError("A tabela pluxee_shared_state não foi inicializada.")
                    if int(current_revision[0]) == revision:
                        return json_response(200, {"state": None, "revision": revision, "unchanged": True})
                return json_response(200, state_response(connection))

            if method == "PUT" and action == "state":
                if not check_origin(request, config):
                    return error_response(403, "A origem desta solicitação não foi autorizada.")
                if session is None:
                    return error_response(401, "Sua sessão expirou. Entre novamente.")
                if not csrf_matches(request, session):
                    return error_response(403, "A sessão expirou. Atualize a página e entre novamente.")
                body = await read_json(request)
                if isinstance(body, JSONResponse):
                    return body
                expected_revision = body.get("revision")
                if (
                    not isinstance(expected_revision, int)
                    or isinstance(expected_revision, bool)
                    or expected_revision < 0
                    or expected_revision > 9_007_199_254_740_991
                ):
                    return error_response(400, "A revisão dos dados é inválida. Atualize o aplicativo e tente novamente.")
                validated_state = validate_state(body.get("state"))
                if isinstance(validated_state, JSONResponse):
                    return validated_state
                cursor = connection.cursor(dictionary=True)
                try:
                    cursor.execute(
                        "SELECT revision, payload FROM pluxee_shared_state WHERE id = 1 FOR UPDATE"
                    )
                    current = cursor.fetchone()
                    if current is None:
                        raise RuntimeError("A tabela pluxee_shared_state não foi inicializada.")
                    current_revision = int(current["revision"])
                    if current_revision != expected_revision:
                        connection.rollback()
                        return json_response(
                            409,
                            {
                                "error": "Outro aparelho salvou alterações. Os dados mais recentes foram carregados.",
                                **state_response(connection),
                            },
                        )
                    previous_state = (
                        json.loads(current["payload"]) if current["payload"] is not None else None
                    )
                    serialized = json.dumps(validated_state, ensure_ascii=False, separators=(",", ":"))
                    cursor.execute(
                        "UPDATE pluxee_shared_state SET revision = revision + 1, payload = %s WHERE id = 1",
                        (serialized,),
                    )
                    connection.commit()
                finally:
                    cursor.close()
                response = state_response(connection)
                previous_ids = {
                    item["id"] for item in previous_state.get("transactions", [])
                } if previous_state else set()
                added_transactions = [
                    item for item in validated_state["transactions"] if item["id"] not in previous_ids
                ]
                notification_status = "not_applicable"
                if added_transactions and previous_state is not None:
                    latest = added_transactions[-1]
                    account_names = {
                        account["id"]: account["name"] for account in validated_state["accounts"]
                    }
                    notification_status = send_fcm_update(
                        connection,
                        config,
                        latest,
                        account_names[latest["accountId"]],
                        len(added_transactions) - 1,
                    )
                return json_response(
                    200,
                    {
                        **response,
                        "notificationStatus": notification_status,
                    },
                )

            return error_response(404, "Esta operação não existe.")
    except ConfigurationError as error:
        logger.error("Configuração incompleta da API: %s", error)
        return error_response(503, "A API Python ainda não foi configurada. Confira as variáveis de ambiente.")
    except mysql.connector.Error:
        logger.exception("Falha na conexão ou operação do banco MySQL.")
        return error_response(503, "O serviço de armazenamento está indisponível. Confira a configuração do MySQL.")
    except Exception:
        logger.exception("Falha inesperada na API.")
        return error_response(500, "O servidor encontrou um erro inesperado.")


app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.environ.get("APP_ORIGIN", "https://imaginative-hamster-ad00a3.netlify.app")],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Accept", "Authorization", "Content-Type", "X-CSRF-Token"],
    max_age=600,
)


@app.api_route("/api/", methods=["GET", "POST", "PUT", "DELETE"])
async def api(request: Request) -> JSONResponse:
    return await api_handler(request)
