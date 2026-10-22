# Homologação técnica final — Distributed Wagering Processor

**Data da execução:** 21/10/2026
**Projeto isolado:** `jungle-homologation-91cf8f`
**Resultado:** **NÃO APTO para preparação final da entrega**. A instalação limpa, fluxos financeiros, testes, concorrência e reinício com persistência PostgreSQL passaram. O reinício do LocalStack perdeu as filas e mensagens previamente presentes; readiness retornou 503 até reexecutar `init`. A perda de eventos após o broker confirmar publicação impede declarar a etapa completa.

## Escopo, isolamento e preservação

Foram lidos integralmente o `README.md` oficial (28.670 caracteres), `ARCHITECTURE.md`, `IMPLEMENTATION_STATUS.md`, `docs/audit/final-architecture/07-RELATORIO-FINAL.md`, `docs/audit/final-architecture/achados.csv` e `docs/audit/manual/CORRECAO-PAGINACAO-LEDGER.md`. O README oficial não foi alterado nesta missão. Os relatórios de auditoria anteriores foram tratados como histórico, não como evidência de aprovação desta versão.

O ambiente executado foi criado com Compose próprio em `docs/audit/homologation/compose.yaml`, projeto `jungle-homologation-91cf8f`, rede `jungle-homologation-91cf8f_default`, volumes nomeados `jungle-homologation-91cf8f-postgres-data` e `jungle-homologation-91cf8f-localstack-data`, banco `jungle_homologation_91cf8f` e filas com prefixo `jh-91cf8f-`. Os mapeamentos foram dinâmicos e limitados a `127.0.0.1`; o estado final está em `run-state.json`. PostgreSQL veio da imagem `postgres:16` (servidor observado 16.15), LocalStack da imagem `localstack/localstack:4.6`, e a aplicação foi construída sem cache com `--pull --no-cache` em imagem exclusiva `jungle-homologation-app:91cf8f`. Não foram usadas imagens da aplicação já executando como prova.

O arquivo temporário de ambiente ficou fora do repositório, contém senhas aleatórias de teste e não usa credenciais reais. As APIs e workers receberam apenas `DATABASE_URL` de `jungle_runtime`; em todas as seis instâncias foi observado `ADMIN_DATABASE_URL` ausente. `init` recebeu a URL administrativa para provisionamento/migrations. O inventário PostgreSQL observou migrations 001, 002 e 003; a role runtime não tinha superuser, CREATEDB, CREATEROLE ou BYPASSRLS. Para a tabela ledger, SELECT e INSERT foram permitidos, enquanto UPDATE/DELETE/TRUNCATE foram negados. A FK composta do ledger estava validada. Evidências: `logs/database-inventory.log` e `logs/acl-probe-result.log`.

Nenhum volume foi removido. Não houve `docker compose down`, `down -v`, commit, push, reset ou reinício de serviços compartilhados. Os containers e volumes isolados permanecem presentes para preservar os dados e as evidências.

## Matriz de homologação

| Fase / requisito | Resultado | Evidência observada |
|---|---|---|
| Leitura da especificação e documentos pedidos | PASS | Leitura integral registrada nesta execução; README preservado. |
| Cursor: validar forma, tipo, wallet e intervalo antes do SQL | PASS | `decodeLedgerCursor` em `src/application/wagering.ts:66`; unitários e integração HTTP incluídos na suíte final. Arrays, número, sequência negativa, não canônica, bigint acima do limite, cursor de outra wallet, base64 inválida e parâmetro duplicado retornaram HTTP 400 `INVALID_CURSOR`, não 503. Token antigo JSON/base64url round-trip continuou aceito. `logs/http-smoke-requests.json`, `logs/test-all-final.log`. |
| `22P02` / `22003` sem alcançar SQL | PASS | Validador rejeita forma/tipo/faixa antes da query; cursores malformados observados por HTTP foram 400. A suíte executou contra PostgreSQL real. Não foi necessário provocar novamente os SQLSTATEs no código corrigido. |
| `restart-check` separado em admin/runtime | PASS | `scripts/restart-check.ts:9-60` exige projeto/banco local isolado e URLs/roles separados; bootstrap/migrations por admin, operações financeiras pela runtime; fixture preservada em `docs/audit/homologation`. `prepare` e `verify` executados, ambos exit 0. Ver `logs/restart-check-prepare.log` e `logs/restart-check-verify.log`. |
| Bloqueio de credenciais/privilégios administrativos na aplicação | PASS no ambiente executado | Guardas em `src/infrastructure/permissions.ts:6`, `src/main.ts:135`, `src/worker.ts:10` e verificação de privilégios em `src/infrastructure/db.ts:21`; unitários/regressão passaram. Todas as APIs/workers usaram `jungle_runtime`; URL administrativa ausente. ACL probe de TRUNCATE/UPDATE/DELETE/ALTER/DROP/CREATE recebeu SQLSTATE `42501`. |
| Regressão automatizada final | PASS | `bun run test:all`: exit 0, 119,29 s, **108/108**: 45 unitários (286 assertions), 60 integração (1.450 assertions), 3 concorrência (21 assertions), 0 falhas. Integrações usaram PostgreSQL e LocalStack reais no Compose isolado. Log completo: `logs/test-all-final.log`. |
| Formatação | PASS | `bun run format:check`: exit 0, 1,83 s, “All matched files use Prettier code style!”. `logs/format-check-final.log`. |
| TypeScript | PASS | `bunx --no-install tsc --noEmit`: exit 0, 8,34 s. `logs/typescript-final.log`. |
| Compose limpo, build e inicialização | PASS | `config --quiet`, pull de PostgreSQL/LocalStack, build atualizado `--pull --no-cache`, criação de volumes/rede, migrations e três filas; `up --wait` exit 0. Logs `compose-config-final.log`, `pull-infrastructure.log`, `build-images-corrected.log`, `compose-up.log`, `initializer.log`. |
| Três APIs e três workers reais | PASS | Seis containers independentes e saudáveis; endpoints health/readiness/metrics responderam HTTP 200. `logs/container-snapshot.jsonl`, `logs/health-metrics-initial.json`, `logs/ready-final.json`. |
| Fluxos BET, WIN, LOSS, REFUND e ROLLBACK via HTTP | PASS | Execução em wallet isolada; saldo final 100,00 BRL, versão 5, cinco lançamentos e reconciliação consistente. Todas as chamadas/respostas e durações estão em `logs/http-smoke-requests.json`; resumo em `logs/http-smoke-summary.json`. |
| Idempotência concorrente entre três APIs | PASS | 30 requests simultâneos, 30 HTTP 200, um transaction ID, 29 replay; saldo 75,00, versão 2, um DEBIT de 25,00, duas linhas de ledger e reconciliação consistente. |
| Concorrência entre operações distintas | PASS | Duas BET de 80,00 simultâneas em duas APIs: uma HTTP 200/PROCESSED, uma HTTP 422/REJECTED `INSUFFICIENT_FUNDS`; saldo 20,00, versão 2, um débito e reconciliação consistente. |
| Cursores HTTP inválidos e paginação | PASS | Token anterior aceito; formas inválidas retornaram HTTP 400 `INVALID_CURSOR`. A suíte PostgreSQL/HTTP final inclui os testes de paginação com limites/timestamps iguais. Evidência adicional de respostas: `logs/http-smoke-requests.json`. |
| SQS real, deduplicação, retries, DLQ e outbox antes do restart | PASS | Mensagem válida enviada à FIFO resultou em BET `PROCESSED`, saldo 75,00, duas entradas e reconciliação consistente. Mensagem permanente inválida alcançou a DLQ depois de cinco tentativas; `maxReceiveCount=5`; request queue ficou vazia. Três endpoints de worker mostraram labels distintos, retry total observado 20 (acumulado por processo durante a execução), DLQ gauge 1 e outbox pending 0. Fila de eventos cresceu de 34 para 36 mensagens durante este cenário. `logs/sqs-e2e-run-final.log`, `logs/sqs-e2e.json`. |
| Persistência de PostgreSQL após reinício isolado | PASS | `restart-check verify` encontrou a mesma transação, replay idempotente, saldo 75,00, ledger com duas linhas e reconciliação consistente; exit 0. APIs voltaram com HTTP 200 e wallet/saldo/ledger permaneceram consistentes. `logs/controlled-restart.log`, `logs/restart-check-verify.log`, `logs/post-restart-api-verification.json`. |
| Persistência e recuperação automática do LocalStack/SQS após reinício | **FAIL** | Antes do restart, as filas continham mensagens (events visíveis 36 e mensagens na DLQ). Após reiniciar somente os containers isolados, os endpoints API retornaram 503 `QueueDoesNotExist`, os três workers encerraram após `ECONNREFUSED`/falha de queue URL e o `ListQueues` não encontrou as filas. A pasta `/var/lib/localstack/state` permaneceu vazia mesmo com `PERSISTENCE=1`, volume montado e estratégia `ON_REQUEST`/`ON_STARTUP`; endpoint oficial de save respondeu HTTP 404. O `init` foi reexecutado e recriou as filas, que então estavam vazias: requests=0, DLQ=0, events=0. Portanto houve perda observável de estado/mensagens do emulador e a recuperação exigiu ação manual. Evidências: `logs/controlled-restart.log`, `logs/reinit-after-localstack-restart.log`, `logs/localstack-persistence-config-recreate.log`, `logs/localstack-explicit-snapshot-probe.json`, `logs/sqs-post-restart-state.log` e logs dos containers. |
| Ausência de dupla contagem de métricas / semântica pós-commit | PASS nos cenários executados | `/metrics` por instância; counters dos workers reiniciaram em zero após restart do processo, conforme escopo por processo; gauges shared outbox/DLQ foram expostos por instância sem somar cópias no coletor. Os testes reais de rollback e workers constam da suíte final. |
| Arquivos de entrega | PASS com divergência documental | Código, migrations, scripts, Dockerfile, Compose, `.env.example`, documentação de arquitetura e testes estão presentes. `IMPLEMENTATION_STATUS.md` ainda descreve contagens antigas (45) e pendências de eventos genéricos já tratadas; atualizá-lo depois da homologação. O README oficial tem comandos de setup vinculados a `docs/SETUP.md`; a configuração adicional limpa foi criada em `docs/audit/homologation/compose.yaml` sem alterar o README oficial. |

## Correções delimitadas e arquivos

- `src/application/wagering.ts:66-91,610-618`: decodificação estrita do cursor opaco antes da query, preservando o formato anterior, limitando a sequência ao bigint PostgreSQL e respondendo 400 `INVALID_CURSOR`.
- `src/infrastructure/permissions.ts:6-20`, `src/main.ts:24,135`, `src/worker.ts:2,10`, `src/infrastructure/db.ts:21-29`: verificações de role e privilégios efetivos antes de servir tráfego.
- `scripts/restart-check.ts:1-155`: exige nomes isolados, duas URLs e roles distintas; admin cria schema e executa provisionamento, runtime executa fluxo de negócio e valida persistência. Não remove schema, wallet nem fixture.
- `test/unit/ledger-cursor.test.ts`, `test/integration/ledger-pagination.test.ts`, `test/integration/corrections.test.ts`: cobertura de cursores inválidos/legados e regressão de role. As assertions anteriores foram mantidas.
- `docs/audit/homologation/compose.yaml`, `.env.example`, `http-smoke.ps1`, `sqs-e2e.ts`, `sqs-tool.ts`, logs e estado: ambiente e harnesses descartáveis/exclusivos. `compose.yaml` usa PostgreSQL e LocalStack novos, três APIs/workers, volumes e portas exclusivos. Estratégias de snapshot foram tentadas na configuração local; a persistência SQS não foi comprovada e falhou na execução.
- `.dockerignore`: `docs/audit/` excluído do contexto Docker, impedindo empacotar evidências e fixtures da auditoria.

O primeiro `test:all` desta sessão teve duas falhas de teste relacionadas à suposição do nome administrativo (`SET ROLE jungle`) e à mensagem do guard. A fixture foi ajustada para usar o admin realmente configurado, preservando a expectativa SQLSTATE 42501, e o teste final completo passou sem falhas. Logs iniciais e finais permanecem em `logs/test-all.log` e `logs/test-all-final.log`. O primeiro build Compose usou um contexto de Dockerfile incorreto e falhou com “open Dockerfile: no such file or directory”; o Compose foi corrigido e o build `--pull --no-cache` posterior passou. A primeira execução HTTP terminou por um defeito do harness PowerShell ao enviar corpo vazio em GET; a execução corrigida passou, logs `http-smoke-run.log` e `http-smoke-run-final.log`. As primeiras tentativas do verificador SQS falharam por critérios do próprio harness (limiar de contagem de eventos e item antigo já existente na DLQ); a segunda falha está transcrita em `logs/sqs-e2e-harness-attempt-2.log`, e a tentativa final passou. Esses erros de harness não alteraram código do produto.

## Divergências e limitações

1. **Bloqueador:** o LocalStack 4.6 usado nesta homologação não restaurou filas/mensagens com a configuração testada. A documentação oficial do LocalStack descreve estado persistido sob `/var/lib/localstack/state` e a estratégia `PERSISTENCE`; aqui o volume permaneceu sem snapshot. O serviço foi reconstituído manualmente via `init` apenas para deixar o ambiente em estado de execução. Não se presume que o mesmo ocorra em AWS SQS, mas a homologação solicitada com LocalStack falhou neste cenário. Ver [LocalStack — Persistence](https://docs.localstack.cloud/user-guide/state-management/persistence/).
2. A publicação outbox/commit foi validada antes do restart, e PostgreSQL conservou os registros `published`; depois do restart, as mensagens que estavam na fila LocalStack não estavam disponíveis. Assim, o requisito de sobrevivência de mensagem/broker ao restart não está aprovado. Não houve alteração financeira nem tentativa de reparar/republicar o histórico durante o diagnóstico. No estado final, após um probe inerte de persistência, `events` contém uma mensagem sintética `HomologationPersistenceProbe`; `requests` e `dlq` estão vazias. A mensagem de probe foi preservada, sem remoção.
3. O restart dinâmico alterou portas mapeadas pelo Docker Desktop. O estado final foi atualizado em `run-state.json`; sempre consulte `docker compose ps --format json`, não reutilize portas gravadas antes de reiniciar.
4. `IMPLEMENTATION_STATUS.md` está desatualizado em itens já corrigidos/contagem de testes; o README oficial foi preservado conforme instrução.
5. A carga foi controlada para cenários de concorrência/idempotência solicitados; esta execução não estima capacidade de produção nem substitui teste prolongado de rede/HA.

## Reexecução limpa por outra pessoa

Use PowerShell 5.1 a partir da raiz. O identificador abaixo cria nomes exclusivos; os dois passwords são aleatórios locais e não devem ser enviados a serviços externos. Não use o Compose compartilhado.

```powershell
Set-Location C:\Users\anton\JungleChallenge
$id = [guid]::NewGuid().ToString('N').Substring(0, 6)
$project = "jungle-homologation-$id"
$envFile = Join-Path $env:TEMP "$project.env"
$template = Get-Content docs/audit/homologation/.env.example -Raw
$content = $template.Replace('replace-with-six-lowercase-hex', $id)
$content = $content.Replace('jungle-homologation-replace', $project)
$content = $content.Replace('jungle_homologation_replace', "jungle_homologation_$id")
$content = $content.Replace('homologation-replace-', "jh-$id-")
$content = $content.Replace('temporary-local-only', [guid]::NewGuid().ToString('N'))
$content = $content.Replace('temporary-runtime-only', [guid]::NewGuid().ToString('N'))
[IO.File]::WriteAllText($envFile, $content, (New-Object System.Text.UTF8Encoding($false)))
$compose = 'docs/audit/homologation/compose.yaml'
docker compose --env-file $envFile -p $project -f $compose config --quiet
docker compose --env-file $envFile -p $project -f $compose pull postgres localstack
docker compose --env-file $envFile -p $project -f $compose build --pull --no-cache init api worker
docker compose --env-file $envFile -p $project -f $compose up -d --no-build --scale api=3 --scale worker=3 --wait --wait-timeout 180
docker compose --env-file $envFile -p $project -f $compose ps --format json
```

`init` cria a role runtime, aplica migrations e cria filas. Extraia os ports publicados do JSON do Compose antes de enviar HTTP. Health é `GET /health/live` e `GET /health/ready`; métricas são `GET /metrics` nas APIs e na porta publicada de cada worker. O cenário HTTP usado está em `docs/audit/homologation/http-smoke.ps1`; SQS real em `docs/audit/homologation/sqs-e2e.ts`. Testes automatizados:

```powershell
& .\docs\audit\homologation\http-smoke.ps1
$state = Get-Content docs/audit/homologation/run-state.json -Raw | ConvertFrom-Json
$env:SQS_ENDPOINT = "http://$($state.hostPorts.localstack)"
$env:SQS_QUEUE_PREFIX = $state.queuePrefix
bun run docs/audit/homologation/sqs-e2e.ts
```

```powershell
bun run test:all
bun run format:check
bunx --no-install tsc --noEmit
```

Para validar `restart-check` em um schema isolado, forneça `ADMIN_DATABASE_URL`, `DATABASE_URL`, `HOMOLOGATION_PROJECT` e `HOMOLOGATION_DATABASE` conforme o arquivo temporário, então execute `bun scripts/restart-check.ts prepare` antes e `bun scripts/restart-check.ts verify` após reiniciar apenas os serviços do projeto isolado. O fixture fica em `docs/audit/homologation/restart-<id>.json` e é preservado. Não use `docker compose down -v` nem remova os volumes nomeados.

## Decisão de entrega

**NÃO APTO**, até que a perda de filas/mensagens SQS após reinício no ambiente isolado seja corrigida ou a homologação seja refeita em um emulador/serviço com estado persistente comprovado, e que as três filas, mensagens, métricas e reconciliação sejam verificadas após o ciclo. Os cenários de funcionamento em ambiente limpo antes do restart, bem como PostgreSQL, APIs, workers, cursor e 108 testes, passaram. Não se declara 100% de correção nem homologação completa.

Os logs completos, corpos HTTP, respostas, estados SQS, inventário de banco e comandos/durações estão em `docs/audit/homologation/logs/`. Nenhuma falha foi corrigida automaticamente após sua reprodução; apenas o initializer isolado foi reexecutado para restaurar a capacidade de diagnóstico, e essa intervenção está registrada.

## Atualização — diagnóstico de persistência LocalStack (21/10/2026)

A classificação geral continua **NÃO APTO**. A reprodução isolada confirmou a falha tanto com `docker compose restart localstack` quanto com `docker compose up -d --force-recreate localstack`, preservando o volume nomeado. Em ambos os ciclos, uma fila FIFO exclusiva com uma mensagem (contagem visível 1) deixou de existir: `ListQueues` ficou vazio e `GetQueueAttributes` respondeu `AWS.SimpleQueueService.NonExistentQueue`. Nenhum worker estava ativo durante os ensaios.

A causa observada é a edição do emulador: `/_localstack/health` reportou `edition=community`, `version=4.6.0`, enquanto o Compose efetivamente entrega `PERSISTENCE=1`, `SNAPSHOT_SAVE_STRATEGY=ON_REQUEST`, `SNAPSHOT_LOAD_STRATEGY=ON_STARTUP` e monta `jungle-homologation-91cf8f-localstack-data` em `/var/lib/localstack` com `RW=true`. O diretório `state` tinha permissões `root:root 755` e permaneceu vazio. O endpoint manual de snapshot de SQS retornou HTTP 404. A documentação oficial atual inclui persistência nos planos Base/Ultimate e exemplifica a imagem Pro com `LOCALSTACK_AUTH_TOKEN`; nenhum token está configurado/disponível nesta execução. Logo, as variáveis e o volume não habilitam snapshots na imagem Community observada.

O initializer não apaga mensagens: `scripts/init-sqs.ts` chama `initQueues()`, e `src/infrastructure/sqs.ts` cria filas e configura a redrive policy sem `DeleteQueue`/`PurgeQueue`. A reexecução histórica do initializer criou filas de aplicação vazias somente depois da perda pelo broker; não causou o desaparecimento original.

Nenhuma correção foi aplicada por falta do requisito de autenticação/licença para uma edição com persistência. O resultado de persistência é **FAIL**; a habilitação e reteste de LocalStack licenciado é **BLOCKED**. A Etapa 8 não deve ser considerada homologada até sobreviver a fila e sua mensagem a restart e recriação, ou até que a recuperação dos eventos confirmados seja demonstrada. Os 108 testes da execução anterior não foram reexecutados nesta investigação, pois não houve alteração de código/configuração. Evidências e comandos reproduzíveis estão em `LOCALSTACK-PERSISTENCIA.md` e `logs/localstack-no-consumer-*.json`.
## Aditivo — interpretação do teste adicional de durabilidade (21/10/2026)

O resultado histórico **FAIL** acima continua sendo o resultado observado do probe que reinicia o LocalStack Community 4.6.0 após mensagens terem sido aceitas e marcadas como publicadas. A decisão posterior em `DECISAO-DURABILIDADE.md` esclarece que esse probe adicional não é o cenário de crash especificado explicitamente na seção 11 do README. Em ambiente isolado novo, a recuperação de outbox após commit e antes do envio foi comprovada com sucesso. Portanto, não se apaga nem se reclassifica o FAIL histórico do emulador; sua interpretação como bloqueador obrigatório de entrega foi revisada. A persistência pós-restart da Community segue sem comprovação e não deve ser declarada PASS.
