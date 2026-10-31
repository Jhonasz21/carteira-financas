# Meu Pluxee

Painel independente para cadastrar cartões, registrar despesas e créditos, acompanhar limites diários e consultar extratos. Os dados são informados manualmente; o aplicativo não se conecta à Pluxee.

Em Configurações, cada cartão pode ser salvo individualmente ou removido quando não tiver movimentações. É necessário manter ao menos um cartão cadastrado.

O botão **Áudio** em cada cartão permite ditar o nome, o tipo de benefício, os últimos quatro dígitos, o saldo inicial e/ou o limite diário em português. Informe somente os campos que deseja alterar; os demais permanecem como estão. Revise a transcrição, aplique os valores e salve o cartão. O tipo do benefício não pode ser alterado nos cartões padrão. O reconhecimento depende do suporte e da permissão de microfone do navegador; o serviço de voz do navegador pode exigir internet. O áudio não é enviado à API do aplicativo.

## Publicação do site no Netlify

O Netlify hospeda apenas os arquivos estáticos da interface. A API Python roda no seu VPS e usa MySQL para persistir e sincronizar os dados; não é necessário publicar uma Netlify Function. O `localStorage` continua sendo usado como cópia local e como origem para a primeira migração.

Para regenerar os arquivos estáticos, execute `node scripts/netlify-build.mjs` e publique a pasta `dist/` no Netlify. O arquivo [`api-config.js`](./api-config.js) deve conter a URL HTTPS pública da API antes do build:

```js
globalThis.MEU_PLUXEE_API_BASE = "https://imaginative-hamster-ad00a3.netlify.app";
```

Depois de alterar esse endereço, regenere e publique `dist/` novamente. Enquanto o endereço estiver vazio, o aplicativo informa que a API precisa ser configurada e pausa a sincronização.

## Publicação da API Python no VPS

A API é uma aplicação FastAPI que preserva a validação, o login compartilhado, a limitação de tentativas, a sincronização por revisões e o formato de dados do aplicativo. Requer Python 3.11+, MySQL 5.7+ ou MariaDB 10.3+, HTTPS público e um domínio apontado para o VPS (por exemplo, `api.seudominio.com.br`).

### 1. Preparar o banco de dados

Crie um banco MySQL e um usuário exclusivo para o aplicativo. Importe [`python-api/schema.sql`](./python-api/schema.sql) no banco; ele cria o estado compartilhado, as sessões, a tabela de limitação de tentativas e os tokens de notificação. A conta da API precisa de permissões `SELECT`, `INSERT`, `UPDATE` e `DELETE` nessas tabelas. Faça backup regular do banco.

### 2. Instalar a API

Envie a pasta `python-api/` e `scripts/hash-password.py` para o VPS, por exemplo em `/opt/meu-pluxee/`, e importe o esquema `python-api/schema.sql` no banco. Instale as dependências em um ambiente virtual:

```sh
cd /opt/meu-pluxee/python-api
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

Gere a senha compartilhada e o segredo de sessão. A senha não aparece no terminal:

```sh
python3 /opt/meu-pluxee/scripts/hash-password.py
```

Crie `/etc/meu-pluxee-api.env` fora da pasta pública, com permissão restrita (`chmod 600`), usando os valores gerados e as credenciais do banco:

```ini
APP_ORIGIN=https://imaginative-hamster-ad00a3.netlify.app
APP_PASSWORD_HASH=scrypt$...
SESSION_SECRET=...
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=meu_pluxee
DB_USER=meu_pluxee
DB_PASSWORD=...
FIREBASE_CREDENTIALS_PATH=/etc/meu-pluxee/firebase-service-account.json
```

Se o site usar um domínio personalizado, substitua `APP_ORIGIN` pela origem HTTPS exata desse site. Não inclua caminho nem barra final. Mantenha os segredos somente no arquivo privado do VPS.

O Firebase é opcional para o restante da API. Para habilitar notificações, crie um projeto Firebase e um app Web. Copie a configuração pública do app Web e a chave de certificado Web Push (VAPID) do Firebase Console para `MEU_PLUXEE_FIREBASE_CONFIG` em `api-config.js`; esses valores são públicos e devem ser publicados junto com o site. Gere uma chave privada de conta de serviço no Firebase Console, copie o JSON para o VPS fora da pasta pública, deixe o arquivo pertencendo ao usuário da API e restrinja a leitura (`chmod 600`). Defina `FIREBASE_CREDENTIALS_PATH` como o caminho absoluto desse arquivo privado. Nunca publique nem envie esse JSON ao navegador ou ao repositório.

#### Instalação da credencial em um servidor Windows

Salve o JSON da conta de serviço fora da pasta do site e do repositório, por exemplo em `C:\ProgramData\MeuPluxee\secrets\firebase-service-account.json`. Copie o arquivo para esse local de forma segura e conceda leitura somente à conta do Windows que executa a API, além de `SYSTEM` e administradores:

```powershell
$secretDirectory = 'C:\ProgramData\MeuPluxee\secrets'
$secretFile = Join-Path $secretDirectory 'firebase-service-account.json'
New-Item -ItemType Directory -Path $secretDirectory -Force
Copy-Item -LiteralPath 'C:\caminho\seguro\firebase-service-account.json' -Destination $secretFile
icacls $secretFile /inheritance:r
icacls $secretFile /grant:r "$($env:USERNAME):(R)" 'SYSTEM:(F)' 'Administrators:(F)'
```

Se a API roda como serviço sob outra conta, substitua `$env:USERNAME` pela identidade real do serviço e conceda a ela leitura (`R`); não conceda acesso a `Users` ou `Everyone`. Defina `FIREBASE_CREDENTIALS_PATH` no ambiente do serviço como o caminho absoluto do JSON. Para testar ao iniciar a API manualmente em PowerShell:

```powershell
$env:FIREBASE_CREDENTIALS_PATH = 'C:\ProgramData\MeuPluxee\secrets\firebase-service-account.json'
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Em produção, configure a variável no gerenciador do serviço Windows e reinicie-o; não use uma variável temporária do terminal como configuração permanente. O backend lê o arquivo apenas no servidor. Não copie o JSON para `dist/`, para `api-config.js` ou para qualquer arquivo servido pelo site.

O botão **Ativar notificações** em Configurações pede autorização no navegador e cadastra o aparelho conectado. O Firebase Cloud Messaging envia um aviso genérico quando um novo gasto ou compra é adicionado a um extrato já inicializado; o payload de dados contém tipo, descrição, valor, data e cartão, e os detalhes são mostrados somente enquanto o app está aberto. A migração inicial, exclusões e alterações sem novo lançamento não geram aviso. Cada navegador deve ativar as notificações individualmente. Após atualizar o backend, instale as dependências com `pip install -r requirements.txt` e importe novamente o `schema.sql` (as instruções são idempotentes).

### 3. Manter o serviço ativo

Crie `/etc/systemd/system/meu-pluxee-api.service`:

```ini
[Unit]
Description=Meu Pluxee Python API
After=network.target

[Service]
User=www-data
Group=www-data
WorkingDirectory=/opt/meu-pluxee/python-api
EnvironmentFile=/etc/meu-pluxee-api.env
ExecStart=/opt/meu-pluxee/python-api/.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8000 --proxy-headers --forwarded-allow-ips=127.0.0.1
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Mantenha o arquivo de ambiente como `root:root` com modo `600`; o systemd o lê antes de iniciar o processo. Garanta que `www-data` possa ler os arquivos da aplicação. Ative o serviço:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now meu-pluxee-api
sudo systemctl status meu-pluxee-api
```

Configure o Nginx para encaminhar a rota `/api/` ao serviço local, e habilite HTTPS para o domínio da API:

```nginx
server {
    listen 443 ssl;
    server_name api.seudominio.com.br;

    client_max_body_size 6m;

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Configure os certificados TLS no bloco Nginx conforme o seu provedor (por exemplo, Certbot/Let's Encrypt). Não exponha a porta 8000 publicamente; ela deve aceitar conexões apenas de `127.0.0.1`.

### 4. Ligar o site à API

Defina `globalThis.MEU_PLUXEE_API_BASE` em [`api-config.js`](./api-config.js) para a origem HTTPS da API (somente protocolo e domínio) e publique novamente a pasta `dist/` no Netlify. A API permite CORS apenas para a origem definida em `APP_ORIGIN`.

Teste `https://api.seudominio.com.br/api/?action=session`: uma resposta JSON com `authenticated: false` indica que a API está acessível. Uma resposta 503 indica que faltam configurações ou que o MySQL está indisponível; consulte `sudo journalctl -u meu-pluxee-api`.

O navegador mantém a sessão de login na sessão da aba e a envia como token bearer; não depende de cookies de terceiros entre Netlify e VPS. Cada aparelho precisa entrar com a senha compartilhada. Ao abrir a primeira vez no aparelho que contém os dados locais, entre nele primeiro: os dados serão migrados se o banco estiver vazio. Se já houver dados no servidor, eles são a referência e as diferenças locais ficam preservadas no backup local, sem mesclagem automática.

O aplicativo consulta atualizações remotas a cada cinco segundos e recusa gravações baseadas em revisões antigas para evitar sobrescrita entre aparelhos. Faça cópias de segurança regulares. Nunca cadastre o número completo, o código de segurança ou a senha do cartão.

### Importar extratos

Use **Baixar modelo CSV** na tela Extratos. A importação é local ao aplicativo e acrescenta as movimentações ao extrato compartilhado. Cada linha precisa ter `data;descricao;valor;tipo;cartao`; datas `DD/MM/AAAA` ou `AAAA-MM-DD`; tipos `despesa` ou `compra`; e o nome exato do cartão ou os seus últimos quatro dígitos, quando forem únicos.
