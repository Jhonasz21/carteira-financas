# Servidor Render

API FastAPI da Carteira Finanças pronta para deploy no [Render](https://render.com).

1. No Render: **New > Blueprint** e selecione este repositório (usa `render.yaml` na raiz).
2. Preencha as variáveis secretas (`APP_PASSWORD_HASH`, `DB_*`). Veja `.env.example`.
3. Crie as tabelas do banco MySQL com `schema.sql`.

Comando de início: `uvicorn app:app --host 0.0.0.0 --port $PORT`

Nunca versione senhas ou credenciais; configure-as apenas no painel do Render.

