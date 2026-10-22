# Correções A01, A02 e A03

**Resultado atual da retomada: PASS — 55 testes aprovados (incluindo os 45 originais), D02/D03 aprovados, A01/A02/A03 verificadas em schemas isolados.** Os registros BLOCKED abaixo pertencem à primeira tentativa com Docker desligado; os resultados atuais e suas evidências estão na conclusão desta página. Não houve implantação nos serviços compartilhados.

Implementação local em 2026-10-21, limitada aos três achados. Os relatórios históricos 06/07 e os resultados da auditoria anterior permanecem como histórico; não foram usados para declarar validação das correções.

## A01 — Role runtime e proteção do ledger

- Mantida a role administrativa original `jungle`, somente para provisionamento e migrations, via `ADMIN_DATABASE_URL`.
- `DATABASE_URL` de API/worker passa a usar `jungle_runtime`. O serviço init é o único que recebe a URL administrativa no `compose.app.yaml`.
- `scripts/provision-db.ts` cria/valida a role runtime, aplica migrations administrativamente e concede somente o necessário: USAGE no schema/sequência; SELECT/INSERT nas cinco tabelas de execução; UPDATE apenas nas colunas usadas de wallet, wager_transaction e outbox. Sem UPDATE/DELETE/TRUNCATE no ledger, sem CREATE no schema, sem acesso à tabela de migrations, sem ownership, memberships ou atributos administrativos. Grants anteriores de tabela e coluna da role são revogados antes da lista mínima.
- API/worker recusam inicializar com superuser, CREATEDB/CREATEROLE, REPLICATION/BYPASSRLS, CREATE no schema ou permissão de alteração/destruição do ledger.
- Migration **002.up/down.sql** acrescenta/remove proteção BEFORE TRUNCATE por statement, reutilizando a função de imutabilidade. Migration 001 up/down está intacta. O runner suporta ambas e mantém o down completo esperado pelos testes existentes.
- `compose.yaml` e os dados/volumes existentes não foram alterados. A separação configurada será aplicada pelo novo init em implantação futura, não às instâncias antigas sem recriação autorizada.

Arquivos: `src/infrastructure/permissions.ts`, `src/infrastructure/db.ts`, `scripts/provision-db.ts`, `scripts/migrate.ts`, `migrations/002.*.sql`, `.env.example`, `compose.app.yaml`, `src/main.ts`, `src/worker.ts`.

## A02 — Métricas somente após commit

`atomic` agora recebe registro de callbacks de pós-commit. Eles são executados somente depois de `commitTransaction()` confirmado e da liberação do QueryRunner. Falha na operação ou no commit descarta os callbacks.

`processed`, `rejected`, `pending` e duplicatas foram movidos para esse mecanismo. O worker de referências usa a mesma implementação. Requests/latência continuam contabilizados depois da chamada atômica bem-sucedida. Retry não reaproveita callbacks da tentativa revertida; replay confirmado não incrementa novamente o status financeiro.

Arquivos: `src/infrastructure/db.ts`, `src/application/wagering.ts`.

## A03 — Correlação HTTP

Middleware HTTP valida X-Correlation-Id (1–128 caracteres; primeiro alfanumérico, demais alfanuméricos/ponto/sublinhado/dois-pontos/hífen) ou gera UUID quando ausente/inválido/múltiplo. O ID é devolvido no response header e propagado por AsyncLocalStorage, header normalizado, application service, log de transação, log de conclusão HTTP, erros e envelope da outbox. O fluxo de abertura também herda a correlação HTTP. Logs fora de HTTP recebem fallback válido.

Não foram alterados payload/hash idempotente, regras financeiras, Money, estados ou resultados de negócio.

Arquivos: `src/application/correlation.ts`, `src/application/observability.ts`, `src/application/wagering.ts`, `src/main.ts`.

## Regressões adicionadas

`test/unit/correlation.test.ts` (2 casos):

1. `A03 correlation accepts bounded safe IDs and replaces missing or invalid headers`.
2. `A03 async correlation is isolated across concurrent requests`.

`test/integration/corrections.test.ts` (8 casos):

1. `A01 runtime role has minimum DML rights and cannot truncate, mutate ledger or administer schema` — inclui remoção de grant de coluna indevido e provisionamento idempotente.
2. `A01 migration 002 upgrades existing ledger without rewriting migration 001 or removing history`.
3. `A02 PROCESSED metric changes only after confirmed commit and never on replay`.
4. `A02 REJECTED metric changes only after confirmed commit and never on replay`.
5. `A02 PENDING_REFERENCE metric changes only after confirmed commit and never on replay`.
6. `A02 pending-reference worker counts terminal rejection only after its commit`.
7. `A01 HTTP runtime refuses administrative database credentials`.
8. `A03 HTTP correlation is generated or validated and propagated to logs and outbox` — sem header, header válido e inválido, requisições paralelas, resposta inválida400 e comparação dos IDs nos logs/outbox.

Total previsto: **55 casos** (27 unidade, 25 integração, 3 concorrência). Os arquivos dos 45 testes anteriores não foram alterados. `test/support.ts` passou a provisionar role restrita por schema: o processo principal mantém conexão administrativa para migrations/injeção de falhas; os processos filhos HTTP/concorrência herdam credenciais runtime. As asserções antigas permanecem intactas. Fixtures usam schemas/roles exclusivos e apenas eles são removidos na limpeza.

## Execuções iniciais — Docker indisponível (histórico)

| Comando | Resultado observado | Estado |
|---|---|---|
| `bun run test:unit` | 27 PASS, 0 FAIL, 63 asserções | PASS |
| `bun run test:all` | Typecheck e 27 unitários passaram; conexão PostgreSQL recusada nos beforeAll de integração; exit1; concorrência não alcançada pelo encadeamento | BLOCKED por infraestrutura |
| `bun run test:integration` | Hooks não conectaram a 127.0.0.1:5432; nenhum cenário de integração validado | BLOCKED |
| `bun run test:concurrency` | beforeAll ECONNREFUSED; nenhum cenário concorrente validado | BLOCKED |
| `bun run format:check` | Arquivos conformes; exit0 | PASS |
| `bunx --no-install tsc --noEmit` | Sem erros; exit0 | PASS |
| D02/D03: `bun docs/audit/corrections-diagnostics.ts` | Conexão inicial recusada; diagnósticos não chegaram a executar | BLOCKED |
| Preservação SHA256 | Migrations001, infraestrutura original, package/lock e os três arquivos de testes anteriores inalterados | PASS |

O runner Bun imprime hooks como `(fail) (unnamed)` e sai com código1. Esses erros estão preservados; não representam asserções financeiras aprovadas ou defeitos atribuídos às correções. Nenhum cenário impedido foi marcado PASS.

Docker foi consultado com autorização restrita, sem mutações: o pipe `dockerDesktopLinuxEngine` não existe e o daemon está indisponível. PostgreSQL em 5432 recusa conexão. Iniciar Docker Desktop pode reativar containers compartilhados com política restart; por isso foi solicitada autorização específica e nenhum serviço foi iniciado/reiniciado automaticamente. A validação real restante depende dessa autorização ou de o usuário disponibilizar Docker/PostgreSQL/LocalStack.

## D02/D03 preparados para reexecução

`docs/audit/corrections-diagnostics.ts` é adicional e preserva o diagnóstico histórico. Usa schema/role novos e o código real, sem mocks:

- D02 exige erro SQLSTATE42501 ao tentar TRUNCATE com runtime, nega privilégios administrativos, confirma saldo/ledger100 e exige que TRUNCATE administrativo normal seja barrado pelo trigger002.
- D03 injeta falha diferida no commit usando somente a conexão administrativa do fixture; exige contador inalterado e saldo100 após rollback; depois remove a falha e exige incremento exatamente1 após commit confirmado.

Com infraestrutura disponível, executar no PowerShell:

```powershell
bun run test:all
bun run format:check
bunx --no-install tsc --noEmit
bun docs/audit/corrections-diagnostics.ts
```

A implantação da separação de roles está preparada, mas **não foi aplicada ao banco compartilhado** nesta execução:

```powershell
# Ambiente local: ADMIN_DATABASE_URL e DATABASE_URL distintas, conforme .env.example
bun scripts/provision-db.ts
```

A recriação de API/worker para usar a nova role exige implantação autorizada; não foi executado docker compose up/restart.

## Evidências

Logs completos e metadados (início/fim UTC, duração, exit code, stdout/stderr) em `docs/audit/logs/`:

- `corrections-unit.*`
- `corrections-integration.*`
- `corrections-all.*`
- `corrections-concurrency.*`
- `corrections-final-format.*`
- `corrections-final-typescript.*`
- `corrections-d02-d03.*`
- `corrections-preservation.*` e `corrections-preservation.json`.

Não houve push, commit, instalação de dependências, remoção de volumes ou reinício de serviços compartilhados. Na primeira tentativa, A01/A02 não foram declaradas validadas porque os testes reais e D02/D03 estavam bloqueados. Esse bloqueio foi superado na retomada abaixo.

## Retomada da validação — 2026-10-21

Docker iniciado manualmente pelo usuário. Consulta `docker compose ps` confirmou somente PostgreSQL16 e LocalStack4.6 ativos e healthy; nenhuma API/worker compartilhada foi iniciada por esta validação.

A leitura inicial `validation-state-before` confirmou conexão PostgreSQL, schema public e contagens zero/digests registrados para wallet, wager_transaction, ledger, inbox e outbox. LocalStack respondeu ListQueues200, mas sem filas compartilhadas; a consulta aos atributos das filas antigas terminou com QueueDoesNotExist (exit1). Esse erro de inventário foi preservado nos logs; não se criaram/recriaram filas compartilhadas. As suítes usam seus próprios schemas, roles e filas aleatórias, conforme test/support.ts e inicializador do fixture.

Execuções e resultados da retomada são registrados abaixo, preservando os bloqueios históricos anteriores.

## Conclusão da retomada — resultados reais

| Execução | Status | Início UTC | Duração | Exit | Evidência |
|---|---|---|---|---|---|
| bun run test:all; exit $LASTEXITCODE | PASS | 2026-10-21T16:11:57.620Z | 63.945 s | 0 | logs/validation-test-all.stdout.log e .stderr.log; .result.json |
| bun run test:concurrency; exit $LASTEXITCODE | PASS | 2026-10-21T16:13:01.626Z | 3.643 s | 0 | logs/validation-concurrency.stdout.log e .stderr.log; .result.json |
| bun docs/audit/corrections-diagnostics.ts; exit $LASTEXITCODE | PASS | 2026-10-21T16:13:05.320Z | 1.057 s | 0 | logs/validation-d02-d03.stdout.log e .stderr.log; .result.json |
| bun docs/audit/validation-http-correlation.ts; exit $LASTEXITCODE | PASS | 2026-10-21T16:14:26.704Z | 4.046 s | 0 | logs/validation-http-correlation.stdout.log e .stderr.log; .result.json |
| bun run format:check; exit $LASTEXITCODE | PASS | 2026-10-21T16:13:23.840Z | 2.006 s | 0 | logs/validation-format.stdout.log e .stderr.log; .result.json |
| bunx --no-install tsc --noEmit; exit $LASTEXITCODE | PASS | 2026-10-21T16:13:25.897Z | 5.92 s | 0 | logs/validation-typescript.stdout.log e .stderr.log; .result.json |
| bun docs/audit/corrections-preservation.ts; exit $LASTEXITCODE | PASS | 2026-10-21T16:13:31.855Z | 0.28 s | 0 | logs/validation-preservation.stdout.log e .stderr.log; .result.json |
| bun docs/audit/validation-evidence.ts; exit $LASTEXITCODE | PASS | 2026-10-21T16:15:12.712Z | 0.932 s | 0 | logs/validation-evidence.stdout.log e .stderr.log; .result.json |

**test:all: 55 PASS, 0 FAIL, 0 BLOCKED** nos casos executáveis. Unidade: 27 PASS/63 asserções; integração: 25 PASS/141 asserções; concorrência: 3 PASS/21 asserções. O comando agregado executou typecheck e os scripts reais das três suítes. Concorrência foi repetida independentemente e os três casos passaram novamente. Os dois diagnósticos e a captura HTTP são verificações adicionais, não novos casos entre os 55.

### Os 45 testes originais

O log desta retomada foi comparado, por caminho e nome real, com as 45 identidades registradas pela auditoria. Resultado em logs/validation-original45.json: **45 identificados, 45 PASS, 0 FAIL, 0 BLOCKED** (25 unitários + 17 integração + 3 concorrência). A nova suíte contém esses 45 mais as 10 regressões de correção. Não se reutilizou resultado histórico de aprovação: apenas a lista original de identidades serviu de referência.

SHA256 confirmou que os três arquivos dos testes originais e as migrations001 continuam idênticos à auditoria. package.json, bun.lock, compose.yaml e sqs-attributes.json também permanecem intactos. test/support.ts é o fixture administrativo/runtime descrito anteriormente; nenhuma asserção antiga foi removida ou afrouxada. Evidência: logs/validation-preservation.stdout.log.

### A01 e D02 — PASS

A regressão A01 verificou ausência de atributos administrativos, CREATE e permissões de alteração/destruição do ledger. TRUNCATE, UPDATE/DELETE de ledger, ALTER TABLE/DISABLE TRIGGER, CREATE TABLE, DROP TABLE e SET ROLE jungle foram rejeitados pela conexão runtime com SQLSTATE42501. Reaplicação dos grants removeu também um grant indevido de coluna inserido somente no fixture. O processo HTTP recusou credenciais administrativas. A atualização002 preservou saldo/histórico e o ciclo de migrations original passou.

D02, executado com código real e login runtime de fixture, registrou:

- Role fix_5d0ab866500440ada8966e6440c5bccd_rt; rolsuper=false; can_create=false; can_truncate=false.
- TRUNCATE runtime: erro **42501**, sem alterar dados.
- TRUNCATE administrativo normal no mesmo schema isolado: erro **immutable record**, comprovando o trigger002.
- Saldo armazenado100.00, reconstruído100.00, diferença0.00, consistent=true, uma entrada OPENING.

### A02 e D03 — PASS

Passaram as regressões PROCESSED, REJECTED, PENDING_REFERENCE, replay e retomada por worker, incluindo falhas diferidas no commit.

D03 observou contador processed **0 antes, 0 após rollback, 1 após commit confirmado**. A tentativa revertida lançou correction deferred commit failure; saldo e ledger mantiveram100.00, consistent=true, somente a OPENING. Depois da retirada do gatilho de falha do fixture, a mesma operação confirmou e incrementou uma única vez. Evidência integral: logs/validation-d02-d03.stdout.log e logs/corrections-diagnostics.json.

### A03 — PASS

A regressão HTTP verificou IDs ausentes, válidos e inválidos, requisições simultâneas, isolamento de contexto, erros400 e propagação para a outbox.

Uma captura adicional persistiu os logs brutos do processo HTTP isolado. A requisição de BET foi enviada **sem X-Correlation-Id**; recebeu200 e X-Correlation-Id=42b4eff1-b251-489f-bdee-0c9e5b7a9f24. O log transaction da transação ad1ffcb3-9e1f-4a80-909f-78d819c71cc6 e os eventos WagerTransactionProcessed/WalletBalanceChanged carregam exatamente esse ID. Evidências: logs/validation-http-evidence.json, logs/validation-http-child.stdout.log e logs/validation-http-correlation.*.

### Preservação e escopo

Comparação READ ONLY antes/depois das cinco tabelas financeiras public: mesmas contagens (zero) e mesmos digests d41d8cd98f00b204e9800998ecf8427e. Ao final restou somente schema public; nenhum fixture role test_*/fix_* nem fila de fixture permaneceu. Evidência: logs/validation-data-integrity.json e logs/validation-evidence.stdout.log.

Somente fixtures exclusivos foram criados e limpos pelas suítes/diagnósticos. As migrations up/down e injeções de falha foram limitadas a esses fixtures; nenhuma tabela compartilhada foi truncada, atualizada ou removida. Nenhum container/volume foi removido; não houve restart/up de serviços compartilhados, provisionamento no public, push, commit ou alteração adicional de código de produção nesta validação.

**Registro ambiental, separado das correções:** LocalStack está healthy e respondeu ListQueues200, mas as filas compartilhadas antigas não existem após o início manual do ambiente. Os probes validation-state-before/after encerraram com exit1/QueueDoesNotExist ao solicitar atributos dessas filas: consulta de atributos compartilhados **BLOCKED por ausência das filas**, logs completos preservados. Isso não impediu os testes SQS reais: as filas exclusivas de teste foram inicializadas, exercitadas (incluindo DLQ) e limpas pelos fixtures. Não houve recriação automática das filas compartilhadas.

Nenhuma falha funcional de A01/A02/A03 foi encontrada nesta retomada; portanto nenhuma nova alteração foi proposta ou aplicada. A aprovação refere-se aos cenários executados em isolamento. A implantação da nova configuração de roles/migration002 nas instâncias compartilhadas continua fora desta validação e não foi executada. Não se declara o sistema100% correto nem se reaprovam os demais requisitos não cobertos por esta missão.
