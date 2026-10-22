"""Safe scoped failures and one request decision context."""

from dataclasses import dataclass, field
from uuid import uuid4

from starlette.requests import Request
from starlette.responses import JSONResponse

ERRORS: dict[str, tuple[int, str]] = {
    "invalid_request": (400, "Некорректный запрос."),
    "invalid_json": (400, "Некорректный JSON."),
    "invite_invalid": (400, "Приглашение недействительно."),
    "login_unavailable": (409, "Логин недоступен."),
    "auth_required": (401, "Требуется вход."),
    "invalid_credentials": (401, "Неверный логин или пароль."),
    "csrf_failed": (403, "Проверка безопасности не пройдена."),
    "forbidden": (403, "Недостаточно прав."),
    "not_found": (404, "Ресурс не найден."),
    "method_not_allowed": (405, "Метод не поддерживается."),
    "request_timeout": (408, "Время ожидания запроса истекло."),
    "version_conflict": (409, "Данные изменились. Обновите страницу."),
    "invite_state_conflict": (409, "Состояние приглашения изменилось."),
    "already_authenticated": (409, "Сначала выйдите из текущего аккаунта."),
    "principal_mismatch": (412, "Аккаунт изменился. Обновите страницу."),
    "request_too_large": (413, "Запрос слишком большой."),
    "unsupported_media_type": (415, "Неподдерживаемый формат запроса."),
    "validation_error": (422, "Проверьте поля формы."),
    "rate_limited": (429, "Слишком много попыток. Повторите позже."),
    "request_headers_too_large": (431, "Заголовки запроса слишком большие."),
    "auth_busy": (503, "Сервис занят. Повторите позже."),
    "db_busy": (503, "База данных занята. Повторите позже."),
    "service_unavailable": (503, "Сервис временно недоступен."),
    "internal_error": (500, "Внутренняя ошибка сервиса."),
}


class AuthError(Exception):
    """Only static registry entries and allowlisted validation fields cross HTTP."""

    def __init__(
        self,
        code: str,
        *,
        fields: dict[str, list[str]] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.code = code
        self.fields = fields if fields is not None else {}
        self.headers = headers if headers is not None else {}


@dataclass
class Decision:
    deadline: float
    request_id: str = field(default_factory=lambda: str(uuid4()))
    principal: str = "anonymous"
    route: str = "unmatched"


def decision(request: Request) -> Decision:
    """Read the context owned by scoped admission, never a request header."""
    result: Decision = request.scope["auth_decision"]
    return result


def error_response(error: AuthError, context: Decision) -> JSONResponse:
    """Encode a failure without input, SQL, exception text or raw URL."""
    status, message = ERRORS[error.code]
    headers = dict(error.headers)
    if status in {429, 503}:
        headers.setdefault("Retry-After", "1")
    return JSONResponse(
        {
            "error": {
                "code": error.code,
                "message": message,
                "fields": error.fields,
                "request_id": context.request_id,
            }
        },
        status_code=status,
        headers=headers,
    )
