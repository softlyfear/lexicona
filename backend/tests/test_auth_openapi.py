"""The frozen schema must describe implemented runtime routes, not placeholders."""

import runpy
import sys
from pathlib import Path
from typing import cast

import pytest

from lexicona.app import create_app


def obj(value: object) -> dict[str, object]:
    assert isinstance(value, dict)
    return cast(dict[str, object], value)


def test_actual_schema_has_four_auth_routes_and_legacy_health(tmp_path: Path) -> None:
    target = tmp_path / "not-created" / "unused.sqlite3"
    app = create_app(f"sqlite+aiosqlite:///{target}")
    schema = obj(app.openapi())
    paths = obj(schema["paths"])
    assert set(paths) == {
        "/api/v1/auth/csrf",
        "/api/v1/auth/login",
        "/api/v1/auth/me",
        "/api/v1/auth/logout",
        "/api/v1/health/live",
        "/api/v1/health/ready",
    }
    for path in paths:
        operation = obj(
            obj(paths[path])["post" if path.endswith(("/login", "/logout")) else "get"]
        )
        responses = obj(operation["responses"])
        if "/auth/" in path:
            assert {
                "200",
                "401",
                "404",
                "405",
                "408",
                "422",
                "429",
                "431",
                "500",
                "503",
            } <= set(responses)
            for response in responses.values():
                headers = obj(obj(response)["headers"])
                assert {
                    "Cache-Control",
                    "X-Request-ID",
                    "X-Lexicona-Request-Principal",
                } <= set(headers)
                pattern = obj(obj(headers["X-Lexicona-Request-Principal"])["schema"])[
                    "pattern"
                ]
                assert isinstance(pattern, str) and pattern.startswith("^")
            if path.endswith(("/login", "/logout")):
                assert {"403", "412", "413", "415"} <= set(responses)
                parameters = operation["parameters"]
                assert isinstance(parameters, list)
                assert any(
                    obj(p).get("name") == "X-Lexicona-Expected-Principal"
                    and obj(p).get("required") is True
                    for p in parameters
                )
                assert "requestBody" in operation
                assert obj(responses["412"])["x-error-codes"] == {
                    "principal_mismatch": "Аккаунт изменился. Обновите страницу."
                }
        else:
            assert "X-Lexicona-Request-Principal" not in obj(
                obj(responses["200"]).get("headers", {})
            )
    components = obj(obj(schema["components"])["schemas"])
    for name in (
        "CsrfDTO",
        "AuthDTO",
        "MeDTO",
        "LogoutDTO",
        "UserDTO",
        "AuthErrorDTO",
        "AuthErrorDetail",
    ):
        dto = obj(components[name])
        assert dto["additionalProperties"] is False
        required = dto["required"]
        assert isinstance(required, list)
        assert set(required) == set(obj(dto["properties"]))
    user_id = obj(obj(obj(components["UserDTO"])["properties"])["id"])
    assert user_id["pattern"] == (
        "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    )
    assert not target.parent.exists()


def test_export_check_is_stable_and_independent_of_database(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from tools import export_openapi as export

    target = tmp_path / "schema" / "auth-v1.json"
    assert export.main([str(target)]) == 0
    original = target.read_bytes()
    assert export.main(["--check", str(target)]) == 0
    assert export.main([str(target)]) == 0 and target.read_bytes() == original
    assert export.main(["--check"]) == 0
    monkeypatch.setattr(sys, "argv", ["tools.export_openapi", "--check", str(target)])
    monkeypatch.delitem(sys.modules, "tools.export_openapi")
    with pytest.raises(SystemExit) as result:
        runpy.run_module("tools.export_openapi", run_name="__main__")
    assert result.value.code == 0
    target.write_text("{}\n")
    assert export.main(["--check", str(target)]) == 1
    assert export.main(["--check", str(tmp_path / "missing.json")]) == 1
    assert export.main([str(tmp_path)]) == 1
