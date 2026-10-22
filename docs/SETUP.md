# Execução e avaliação

A especificação oficial permanece em `README.md`; a cópia integral anterior à implementação está em `docs/CHALLENGE_ORIGINAL.md`.

## Docker (PowerShell ou shell POSIX)

Requisitos: Docker Desktop com containers Linux; para execução no host, Bun 1.4.3. As dependências exatas estão em `bun.lock`.

```powershell
docker compose -f compose.yaml -f compose.app.yaml up -d --build --scale api=3 --scale worker=3
docker compose -f compose.yaml -f compose.app.yaml ps
docker compose -f compose.yaml -f compose.app.yaml port --index 1 api 3000
```

O último comando informa a porta dinâmica da primeira API. Cada réplica tem porta própria em 127.0.0.1. O serviço `init` aguarda PostgreSQL/LocalStack saudáveis, provisiona a role runtime com privilégios mínimos, executa migrations versionadas via role administrativa e cria idempotentemente as filas de entrada, DLQ e eventos. Não depende das filas criadas manualmente nem de `sqs-attributes.json`.

O `compose.yaml` original e seu volume PostgreSQL foram preservados. `compose.app.yaml` acrescenta apenas os serviços da aplicação. Para interromper a aplicação sem tocar na infraestrutura:

```powershell
docker compose -f compose.yaml -f compose.app.yaml stop api worker
```

Não remova volumes. A migration down remove as tabelas financeiras e é destinada somente a bases descartáveis de avaliação, nunca à base de desenvolvimento com dados a preservar.
Para um ambiente avaliador descartável com projeto, portas dinâmicas e volumes próprios, use `docs/audit/homologation/compose.yaml` e seu `.env.example`, copiado para um arquivo temporário fora do repositório. O relatório `docs/audit/homologation/RELATORIO-FINAL.md` registra comandos e portas observados. Antes de qualquer restart-check ou reinício, confirme que o nome do projeto Compose é o isolado esperado.

## Execução no host

```powershell
Copy-Item .env.example .env
bun install --frozen-lockfile
docker compose up -d
bun scripts/provision-db.ts
bun run init:sqs
bun run start
```

Em outro terminal: `bun run worker`. Bun carrega `.env` automaticamente. API no host: `http://127.0.0.1:3000`. Dentro do Compose os serviços usam `postgres:5432` e `localstack:4566`; fora dele usam 127.0.0.1. As credenciais de exemplo são exclusivamente locais.

## Exemplo financeiro no PowerShell

Defina `$base` com a URL da API no host ou com a porta informada pelo Compose.

```powershell
$base = 'http://127.0.0.1:3000'
$player = [guid]::NewGuid().ToString()
$walletBody = @{ playerId=$player; initialBalance=@{ amount='100.00'; currency='BRL' } } | ConvertTo-Json
$wallet = Invoke-RestMethod -Method Post -Uri "$base/wallets" -ContentType 'application/json' -Body $walletBody
$external = [guid]::NewGuid().ToString()
$body = @{ providerId='provider-a'; externalTransactionId=$external; playerId=$player; walletId=$wallet.id; roundId='round-1'; gameId='game-1'; kind='BET'; money=@{ amount='25.00'; currency='BRL' } } | ConvertTo-Json
$headers = @{ 'Idempotency-Key'="provider-a:$external" }
Invoke-RestMethod -Method Post -Uri "$base/wagering/transactions" -Headers $headers -ContentType 'application/json' -Body $body
Invoke-RestMethod -Method Post -Uri "$base/wagering/transactions" -Headers $headers -ContentType 'application/json' -Body $body
Invoke-RestMethod -Method Post -Uri "$base/wallets/$($wallet.id)/reconciliation"
```

O segundo envio retorna replay, sem novo débito, com o saldo da resposta original.

Exemplo curl:

```sh
curl http://127.0.0.1:3000/health/ready
curl -X POST http://127.0.0.1:3000/wallets -H 'Content-Type: application/json' -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

Rotas implementadas: criação/consulta de wallet, ledger paginado, transação por ID interno ou por provider/external ID, submissão, reconciliação, `/health/live`, `/health/ready` e `/metrics`. Ledger retorna `entries` e `nextCursor`; limite padrão 50, máximo 100. O cursor pertence à wallet e usa sequência monotônica serializada como string.

HTTP: 200 processada/replay; 201 criação de wallet e reconciliação; 202 referência pendente; 400 formato inválido; 404 inexistente; 409 conflito; 422 rejeição de negócio; 503 dependência indisponível. O header de idempotência é obrigatório. `OPENING` não é aceito pela API nem pela fila.

## Testes

Inicie somente a infraestrutura e instale as dependências antes de executar:

```powershell
bun run format:check
bun run test:unit
bun run test:integration
bun run test:concurrency
bun run test:all
```

`test:all` executa typecheck, unidade, integração e concorrência. As suítes de integração/concorrência criam schemas PostgreSQL e filas SQS com identificadores aleatórios; removem somente seus próprios schemas e filas ao terminar. Não substituem PostgreSQL ou SQS por mocks. Não execute simultaneamente suítes individuais e `test:all` no mesmo processo Bun. Use os scripts separados: `bun test` sem argumentos não é o comando agregado suportado.

A integração mata processos filhos nos pontos de falha, testa DLQ com cinco recebimentos e causa falhas reais de conexão. Não exige privilégios Docker no processo de testes; precisa de acesso ao PostgreSQL/LocalStack. A verificação adicional de reinício usa um schema isolado, mas reinicia os serviços do Compose e causa indisponibilidade breve:

```powershell
bun scripts/restart-check.ts prepare
docker compose -f compose.yaml -f compose.app.yaml restart postgres api worker
bun scripts/restart-check.ts verify
```

A etapa verify confere replay, saldo e ledger e remove somente o schema de teste. Resultados executados: `docs/TEST_RESULTS.md`. Escopo, decisões e limitações: `ARCHITECTURE.md` e `IMPLEMENTATION_STATUS.md`.

Atualização A01–A03: `ADMIN_DATABASE_URL` destina-se exclusivamente a provisionamento/migrations; API/worker usam `DATABASE_URL` restrita. Copie ambas do `.env.example` para execução local; no Compose somente init recebe a URL administrativa. `bun run migrate` continua disponível para migrations administrativas; após novas migrations que recriem tabelas, execute `bun scripts/provision-db.ts` para reaplicar os grants. Não execute `up`, `restart` ou recriação dos serviços compartilhados sem autorização; as instâncias já em execução só receberão estas mudanças em implantação posterior. Resultados desta correção: `docs/audit/CORRECOES.md`.
