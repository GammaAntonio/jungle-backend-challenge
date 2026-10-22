# AR09 — observabilidade dos workers

**Resultado final: PASS no ambiente isolado — 94 testes aprovados (79 anteriores + 15 novos), 0 FAIL, 0 BLOCKED; formatação, TypeScript e diagnóstico aprovados. Houve comprovação com três workers reais, API, PostgreSQL e LocalStack.** A configuração nova não foi aplicada aos containers compartilhados. As duas execuções reprovadas dos testes novos estão preservadas e explicadas abaixo.

## Registro inicial, antes de concluir a validação

Reprodução anterior confirmada com API e worker reais: worker confirmou BET, saldo 75.00, API expôs processed=0 e requests=0; worker original não tinha listener de métricas. Evidências: [ar09-before.json](ar09-before.json) e [logs](../logs/ar09-before.stdout.log).

Primeira execução dos testes novos de workers em 2026-10-21T18:40:23.211Z: **10 PASS, 2 FAIL, exit1**, duração44.326s. Não foi declarada aprovação da correção.

- DLQ: expectativa de duas tentativas após configurar redrive2 no fixture; observado sqsRetries3, embora a mensagem tenha chegado à DLQ. Necessário confrontar com recebimentos reais/logs por mensagem; o limite de redrive não deve ser confundido com o contador observado de falhas.
- Reinício: nova instância respondeu, labels estáveis e contadores zerados foram verificados; novo processamento não foi observado dentro de15s. Visibilidade de mensagens é30s e havia outros receivers interrompidos. Recuperação após visibilidade é hipótese a verificar, não causa já comprovada.

Logs completos: [ar09-workers.stderr.log](../logs/ar09-workers.stderr.log), [stdout](../logs/ar09-workers.stdout.log), [metadados](../logs/ar09-workers.result.json), [snapshot da primeira tentativa](ar09-workers-attempt1.json). Demais10 cenários passaram, incluindo rollback sem sucesso, coleta dos três processos e comparação de gauges compartilhados. Três testes unitários de classificação/agregação também passaram.

Esse foi o registro de trabalho anterior à conclusão. Nenhuma alteração em migrations, AR01 ou contratos AR02 foi necessária para tratar essas falhas.

Segunda execução: **11 PASS, 1 FAIL**, duração58.757s. Reinício passou: recuperação observada em cerca de30s; o prazo anterior de15s era incompatível com a visibilidade de30s. O teste DLQ conferiu contador contra os logs reais, mas supôs que a concatenação dos logs dos workers estivesse em ordem temporal: o primeiro registro do worker0 era a tentativa3, enquanto as tentativas1/2 estavam nos outros workers. A verificação final usa os valores reportados, sem assumir ordem entre processos. Evidências completas em `ar09-workers-02.*` e `ar09-workers-attempt2.json`; não se declarou aprovação antes de resolver essa asserção.

Terceira execução focada: **12 PASS, 0 FAIL**, exit0, 60.220s; o teste de reinício levou31.719s e confirmou saldo/reconciliação, não apenas o reset de contadores. Na regressão completa, os mesmos12 casos passaram novamente. Não se alteraram assertions ou arquivos dos79 testes anteriores.

## Reprodução do AR09 e conclusão do diagnóstico

Antes da correção, processos reais separados executaram a API e `src/worker.ts`. O worker PID19876 confirmou uma BET via SQS; saldo final75.00, transação PROCESSED e log de transação no worker. O endpoint da API PID21984 respondeu processed=0, requests=0, latencyMs=0, retries=0 e duplicates=0. O arquivo original do worker não tinha servidor/exporter de métricas. Isso comprovou que **o endpoint da API não observa os contadores de outro processo**, embora seus gauges de dependências sejam globais. O diagnóstico não provou perda de transação nem ausência de incremento no objeto em memória do worker; provou ausência de exposição desse objeto.

Reprodução: [ar09-before.json](ar09-before.json), [stdout](../logs/ar09-before.stdout.log), [metadados](../logs/ar09-before.result.json). Nenhum dado compartilhado foi usado para o cenário. O auxiliar `ar09-before.ts` é um diagnóstico histórico do código anterior: sua observação de inexistência de listener corresponde à execução registrada antes da edição, não ao estado corrigido.

## Arquitetura de coleta adotada

- **Formato JSON, sem dependência nova:** reutiliza o formato do endpoint existente. Cada API continua expondo GET `/metrics` em sua porta HTTP; cada worker passa a expor GET `/metrics` em servidor Bun próprio. Não foi introduzido Prometheus, dashboard, registry, tabela de métricas ou tráfego financeiro HTTP para alimentar os workers.
- **Escopo explícito:** `labels.instance` e `labels.role` identificam a amostra. `processStartedAt` identifica a época dos contadores; `sampledAt` informa quando a amostra foi montada. `scope.counters="process"`, `scope.outbox="shared"` e `scope.dlqMessages="shared"` distinguem as semânticas.
- **Contadores locais:** cada processo incrementa somente seus próprios valores. A API não finge representar o total do cluster nem importa contadores de outros processos para sua memória. Coletar todos os endpoints é necessário para obter o total.
- **Coleta conjunta:** `bun scripts/collect-metrics.ts <urls...>` consulta APIs/workers e aplica `aggregateMetrics`. Instâncias repetidas são deduplicadas por role+instance; a época mais recente substitui a anterior após reinício. Contadores de instâncias distintas são somados. DLQ, pending e lag da outbox usam **max**, nunca soma de cópias do mesmo recurso.
- **Dados compartilhados somente leitura:** gauges consultam PostgreSQL e SQS. Um probe rejeitado deixa a gauge correspondente null e marca `dependencies` false, mantendo os contadores locais acessíveis. Health/readiness continua verificando PostgreSQL e a fila de entrada independentemente da coleta das gauges.

O coletor deve receber instâncias do **mesmo banco/schema e conjunto de filas**. Não há descoberta de recursos ou agrupamento automático de ambientes diferentes. Não se deve misturar produção e teste ou filas distintas numa mesma agregação; isso invalidaria a regra de max. Nenhum serviço novo central de agregação é necessário.

## Métricas e semântica

| Campo JSON | Tipo e unidade | Escopo e regra |
|---|---|---|
| processed, rejected, pending | Counters de transições confirmadas | PROCESSED, REJECTED, entrada em PENDING_REFERENCE; callbacks somente após commit |
| duplicates | Counter | Replay/inbox deduplicada confirmados; não repete contador financeiro |
| requests, latencyMs | Counter de chamadas concluídas e soma de duração em ms | Semântica anterior preservada: submit bem-sucedido, inclusive replay; exclui rollback |
| sqsRetries | Counter | Uma falha tratada por tentativa de mensagem SQS, permanente ou transitória |
| outboxRetries | Counter | Uma falha tratada na validação/envio/marcação de um evento da outbox |
| transactionRetries | Counter | Retentativa limitada de transação para os SQLSTATEs já tratados |
| retries | Counter total compatível | Soma dos três canais anteriores; não somar novamente retries com seus componentes |
| lockConflicts | Counter | Deadlock40P01 ou serialização40001 que causam retry; espera normal de row lock não é conflito contado |
| uniqueConflicts | Counter | Retry de unicidade23505 separado de conflito de lock; não altera a decisão de retry financeira |
| divergences | Counter | Divergência de reconciliação detectada pelo processo, sem reparo automático |
| processing.sqs.count / latencyMs | Counter de tentativas e soma de duração em ms | Todos os handlers de mensagem, incluindo falhas; exclui tempo de long polling ocioso |
| processing.outbox.count / latencyMs | Counter de tentativas e soma de duração em ms | Por evento reclamado, inclui validação/envio/ack de publicação e falhas |
| processing.reference.count / latencyMs | Counter de candidatos e soma de duração em ms | Tentativa de retomada de referência; pode incluir candidato já resolvido por outra instância |
| dlqMessages | **Gauge aproximada**, quantidade | Estoque observado no broker; aumenta quando uma mensagem chega e pode diminuir se removida. Não é contador cumulativo de entradas |
| outbox.pending | Gauge, quantidade | Eventos ainda não publicados no banco, inclusive os aguardando backoff |
| outbox.lag_seconds | Gauge, segundos | Idade da ocorrência do evento pendente mais antigo, calculada pelo PostgreSQL |

Para latência média operacional por canal, usar delta(latencyMs)/delta(count) da mesma época. Não há histogramas, p95 ou p99 nesta entrega. Counters de status registram transições, não o número atual de linhas em cada estado: uma pendência que depois é rejeitada pode incrementar pending e rejected em momentos diferentes. OPENING interna continua fora dos contadores legados de submit; FAILED não é materializado pelo runtime para indisponibilidade transitória, conforme a arquitetura existente. Esses limites anteriores não foram alterados para ampliar AR09 ao domínio financeiro.

**A02 preservada:** instrumentação de tentativas/erros em finally não significa sucesso. processed/rejected/pending/duplicates continuam registrados depois de commit confirmado. A medição de tempo/custo de tentativa pode crescer no rollback, mas os contadores de sucesso e requests não. Não foram movidos callbacks para antes do commit.

## Instâncias, labels e acesso

Labels permitidas são somente `{instance,role}`. Role é fixada pelo entrypoint como api ou worker. `METRICS_INSTANCE_ID` aceita identificador operacional de1–64 caracteres seguros; na ausência, usa hostname limitado+PID. Não há walletId, transactionId, messageId, providerId, payload, valor financeiro, URL de banco ou credencial como label. Para manter a identidade lógica ao reiniciar um processo no host, configure um INSTANCE_ID fixo e **único por slot**; o default identifica o processo físico e pode mudar com o PID.

| Processo | Porta/endpoints | Configuração |
|---|---|---|
| API | Porta HTTP existente; `/metrics`, `/health/live`, `/health/ready` | `PORT`; role api |
| Worker | Porta3001 por padrão; mesmos três endpoints | `METRICS_HOST` padrão127.0.0.1; `METRICS_PORT`; role worker |
| Fixture | Portas dinâmicas (`PORT=0`, `METRICS_PORT=0`) | IDs fixos ar09-worker-0/1/2 e ar09-api |

Em `compose.app.yaml`, somente o worker recebe METRICS_HOST0.0.0.0 dentro do container e publica3001 em porta dinâmica de loopback no host. Escalar workers não gera conflito de porta. A infraestrutura original `compose.yaml` e seus volumes permanecem intactos; não se executou up/restart/recriação para aplicar esse YAML.

API e worker respondem liveness sem depender das gauges. Worker readiness fica503 durante stopping ou falha de dependência. Um endpoint `/metrics` saudável pode responder200 com informação parcial e null nas gauges; isso não transforma readiness em200. Em teste com API apontada a endpoint SQS inacessível, liveness200, readiness503 e metrics200/dependencies.sqs=false foram observados.

## Prova com três workers reais

Execução final no schema `test_1a02e29721d841d5a735c001c6ff4ce3`, mesma base e mesmas filas entre os três workers. Nenhum mock substituiu PostgreSQL/SQS. Trinta wallets e operações de seed foram produzidas pelo fixture, sem tráfego financeiro na API.

| Processo real | PID | instance | role | processed inicial | requests inicial |
|---|---:|---|---|---:|---:|
| Worker0 |22244|ar09-worker-0|worker|10|10|
| Worker1 |17764|ar09-worker-1|worker|11|11|
| Worker2 |15336|ar09-worker-2|worker|9|9|
| API | PID não capturado |ar09-api|api|0|0|

Resultados observados:

- Soma dos workers30, API0. O coletor acessou os três endpoints e a API e deduplicou uma URL de worker repetida, mantendo quatro instâncias.
- Antes do reinício, coleta conjunta: processed32, rejected1, pending1, duplicates2, requests35, sqsRetries4. Três falhas correspondiam ao poison entregue à DLQ; uma correspondia ao rollback injetado. O contador total retries4 não foi somado novamente aos canais.
- O estoque da DLQ foi1 em cada um dos quatro endpoints: somar respostas daria4 incorretamente. O coletor retornou **1**.
- Lag observado na coleta conjunta:124.220416s; pending1. Não se somou esse tempo quatro vezes. O fixture criou apenas um evento pendente atrasado e com next_attempt_at futuro para impedir publicação durante o probe.
- Latência acumulada observável: SQS2072.1419ms/39 tentativas; outbox4714.6541ms/134 tentativas; referências22.6731ms/1 tentativa. Os valores são amostras da execução, não metas de desempenho.
- Rollback real no commit de inbox: total processed **31 antes, 31 depois do rollback, 32 depois da confirmação**. Saldo ficou100.00 no rollback e75.00 após redelivery/commit, com reconciliação consistente.
- Reinício somente do worker0: mesmo instance, nova processStartedAt; processed **11 → 0 → 1**. Outros dois workers mantiveram seus contadores. Gauges continuaram refletindo o banco/fila. O novo worker voltou a processar uma BET e reconciliou saldo75.00.
- Durante recuperação, o broker reportou0 mensagens visíveis e1 em voo; a nova instância concluiu o trabalho após30926ms. Isso é consistente com recuperação pela visibilidade de30s. Não se atribuiu de forma conclusiva o recebimento em voo a um receiver específico já interrompido.

Artefatos: [ar09-workers.json](ar09-workers.json) contém snapshots, PIDs, logs dos processos e coleta real via CLI; [ar09-verification.json](ar09-verification.json) resume os números, preservação e comparação dos testes; [diagnóstico completo](../logs/ar09-diagnostics.stdout.log).

## Testes exigidos e resultados

Todos os12 itens abaixo foram executados em `test/integration/worker-metrics.test.ts`, com workers reais. Cada caso tem nome exato e resultado no [log da execução focada](../logs/ar09-workers-03.stderr.log) e na [regressão completa](../logs/ar09-test-all.stderr.log).

| Item | Esperado | Observado final | Status |
|---|---|---|---|
| 1. Exclusivo do worker | Progresso sem operação HTTP financeira na API | Workers30, API0 | PASS |
| 2. Por instância | Quatro identidades separadas; scrape repetido não duplica | Três roles worker e uma api; soma correta | PASS |
| 3. Retry SQS | Contador somente do canal tratado | Retries SQS cresceram; outbox não cresceu nesse cenário; total igual ao delta do canal | PASS |
| 4. DLQ | Estoque real visível; sem duplicação de gauge | Poison alcançou DLQ, gauge1, agregado1 | PASS |
| 5. Dedup | Três entregas, um débito, duas duplicatas | Saldo75.00 e uma linha DEBIT, duplicates+2 | PASS |
| 6. Outbox lag | Atraso mensurável e não somado | Pelo menos120s em todas as amostras | PASS |
| 7. Latência | SQS/outbox/referências mensuráveis | Contagens e somas positivas | PASS |
| 8. Rollback | Nenhum sucesso antes de commit | Processed31→31→32 | PASS |
| 9. Três workers | Três PIDs ativos e coleta real |22244/17764/15336 e CLI com quatro instâncias | PASS |
| 10. Labels | Estáveis e sem dados de negócio | Somente instance/role; payloads/IDs individuais ausentes nas métricas | PASS |
| 11. Health | Ready/live preservados; métricas parciais honestas |200 saudável; ready503 em falha SQS, metrics200 com sinalização | PASS |
| 12. Reinício | Nova época e counters0, retomada segura | Mesmo instance, novo início, counter0→1 e saldo/ledger corretos | PASS |

Três unitários adicionais verificaram classificação dos retries/locks, soma local versus max compartilhado e substituição da época antiga depois do restart. Nenhum desses testes unitários foi tratado como substituto da comprovação real.

### Falhas históricas dos testes novos

As primeiras execuções tinham expectativas inadequadas sobre entrega e ordem de logs. A política de redrive foi alterada somente no fixture descartável para2 recebimentos, visando reduzir a duração; o LocalStack com três receivers entregou tentativas1,2,3 antes da DLQ. O contador passou a ser conferido contra os recebimentos/logs efetivamente observados, não contra o número configurado. A origem exata da entrega adicional não foi investigada nesta correção; não se alterou o broker ou a política padrão5 da aplicação para mascará-la.

A concatenação dos logs por worker não é uma ordenação temporal, por isso a primeira tentativa entre todos os logs é verificada pelo menor ApproximateReceiveCount, e o total de retries é comparado à quantidade real de falhas desse messageId. Após ajustar o prazo do restart à visibilidade real e essa verificação de ordem, os12 cenários passaram duas vezes. **Os79 testes anteriores não foram modificados.**

## Arquivos e linhas alterados

| Arquivo | Alteração isolada de observabilidade |
|---|---|
| [observability.ts:1](../../../src/application/observability.ts#L1) | Identidade/época, canais de retry e medições de tentativa/latência; preserva log/correlação e interface de identidade |
| [metrics.ts:6](../../../src/infrastructure/metrics.ts#L6) | Novo módulo: readiness, snapshot de métricas, agregação e servidor do worker |
| [metrics.ts:66](../../../src/infrastructure/metrics.ts#L66) | Agregação sem dupla contagem e tratamento de época |
| [metrics.ts:124](../../../src/infrastructure/metrics.ts#L124) | Endpoints próprios do worker |
| [main.ts:35](../../../src/main.ts#L35) | Role api e reutilização da coleta/readiness; rotas financeiras e correlação preservadas |
| [worker.ts:8](../../../src/worker.ts#L8) | Role worker, listener e fechamento após os loops existentes |
| [consumer.ts:62](../../../src/infrastructure/consumer.ts#L62) | Contador de retry SQS e finally de medição; ack/transação/visibilidade mantidos |
| [outbox.ts:47](../../../src/infrastructure/outbox.ts#L47) | Contador de retry outbox e finally de medição; validação AR02/claim/send mantidos |
| [wagering.ts:289](../../../src/application/wagering.ts#L289) | Somente classificação do retry e medição de retomada em :537; queries, regras, payloads e callbacks pós-commit preservados |
| [collect-metrics.ts](../../../scripts/collect-metrics.ts) | Coletor explícito por URLs, sem registry ou dependência nova |
| [compose.app.yaml:36](../../../compose.app.yaml#L36) | Configuração futura da exposição de métricas do worker em loopback |
| [managed-process.ts](../../../test/helpers/managed-process.ts) | Harness para iniciar/drenar/parar somente processos próprios e registrar PIDs/logs |
| [metrics.test.ts](../../../test/unit/metrics.test.ts) | Três testes unitários novos |
| [worker-metrics.test.ts](../../../test/integration/worker-metrics.test.ts) | Doze casos reais novos e captura de evidências |
| ARCHITECTURE.md | Descrição da coleta por processo, agregação e configuração |

## Regressão, comandos e evidências

**Regressão: 94 PASS, 0 FAIL, 0 BLOCKED** — 41 unitários/235 asserções, 50 integrações/480 asserções, 3 concorrência/21 asserções. Comparação por arquivo+nome confirmou os mesmos79 casos anteriores novamente aprovados, mais15 novos. Arquivos anteriores de teste estão idênticos por SHA256. Não se reutilizou resultado histórico como nova aprovação.

Comandos via PowerShell; cada `.result.json` aponta para stdout/stderr integrais. Horários abaixo em UTC de2026-10-21; duração inclui o runner.

| Comando | Início UTC | Duração | Exit | Resultado/evidência |
|---|---|---:|---:|---|
| `bun docs/audit/architecture/ar09-before.ts` |18:31:14.297|3.271s|0|Reprodução da lacuna anterior; [ar09-before.result.json](../logs/ar09-before.result.json) |
| `bun test test/unit/metrics.test.ts` |18:40:20.715|1.044s|0|3 PASS; [ar09-unit.result.json](../logs/ar09-unit.result.json) |
| `bun test test/integration/worker-metrics.test.ts --timeout 60000`, tentativa1 |18:40:23.211|44.326s|1|10 PASS/2 FAIL; [ar09-workers.result.json](../logs/ar09-workers.result.json) |
| Mesmo comando, tentativa2 |18:43:50.227|58.757s|1|11 PASS/1 FAIL; [ar09-workers-02.result.json](../logs/ar09-workers-02.result.json) |
| Mesmo comando, tentativa3 |18:45:29.744|60.220s|0|12 PASS/0 FAIL; [ar09-workers-03.result.json](../logs/ar09-workers-03.result.json) |
| `bun run test:all` |18:46:02.016|95.640s|0|94 PASS/0 FAIL; [ar09-test-all.result.json](../logs/ar09-test-all.result.json) |
| `bun run format:check` |18:46:02.702|1.789s|0|PASS; [ar09-format.result.json](../logs/ar09-format.result.json) |
| `bunx --no-install tsc --noEmit` |18:46:03.468|6.647s|0|PASS; [ar09-typescript.result.json](../logs/ar09-typescript.result.json) |
| `bun docs/audit/architecture/ar09-evidence.mjs` |18:50:01.573|0.411s|0|Preservação, números dos três workers e comparação79→94; [ar09-diagnostics.result.json](../logs/ar09-diagnostics.result.json) |

Para repetir as verificações isoladas com PostgreSQL/LocalStack disponíveis:

```powershell
Set-Location C:\Users\anton\JungleChallenge
bun test test/unit/metrics.test.ts
bun test test/integration/worker-metrics.test.ts --timeout 60000
bun run test:all
bun run format:check
bunx --no-install tsc --noEmit
```

O próprio teste cria schemas/roles/filas aleatórios e inicia três workers/API em portas dinâmicas; não exige reiniciar containers. Para coletar instâncias já configuradas, use as portas reais e somente endpoints do mesmo deployment:

```powershell
$targets = @(
  'http://127.0.0.1:3000/metrics',
  'http://127.0.0.1:3001/metrics',
  'http://127.0.0.1:3002/metrics',
  'http://127.0.0.1:3003/metrics'
)
bun scripts/collect-metrics.ts @targets
```

As portas acima são exemplos, não as portas temporárias encerradas dos fixtures. Em instâncias Compose futuras já implantadas com a configuração nova, a descoberta de porta é read-only: `docker compose -f compose.yaml -f compose.app.yaml port --index 1 worker 3001` (repetir o index para cada worker). Nenhum comando de implantação foi executado nesta tarefa.

## Limites, trade-offs e preservação

- A coleta é uma amostra distribuída, não um snapshot transacional do cluster. Gauges SQS são aproximadas; usar max evita multiplicar cópias, mas pode conservar temporariamente a maior observação entre probes próximos.
- Contadores são por processo e zeram após restart. `processStartedAt` permite detectar o reset; o coletor não acumula histórico de processos mortos. Histórico/rates duráveis exigem armazenamento de amostras externo; não foi imposto dashboard nem dependência nova.
- Cada coleta consulta PostgreSQL/SQS, sem cache; probes rejeitados produzem informação parcial explícita. O tempo de resposta ainda depende das bibliotecas/dependências; não se comprovou comportamento sob partição de rede prolongada. O teste de degradação usa conexão SQS recusada. Startup do worker ainda exige connectRuntime/initQueues antes de abrir o listener.
- A CLI exige endpoints disponíveis e falha se uma consulta HTTP não puder ser concluída, em vez de declarar a instância ausente como zero. Labels configuradas devem ser únicas; usar a mesma identidade para dois processos vivos causa deduplicação incorreta. Cada coleta deve limitar-se a um conjunto de recursos compartilhados.
- Retries contam os caminhos já tratados de mensagem/outbox/transação. Falhas no long polling/inicialização que não chegaram a um handler continuam identificadas pelos logs e readiness; não são confundidas com tentativas financeiras processadas.
- Instrumentação de status mantém o escopo anterior de submit/retomada. Não se alteraram a modelagem financeira, as regras de OPENING ou a política de FAILED para ampliar o escopo de AR09.
- Os arquivos dos79 testes anteriores, migrations001/002/003, runner DB, classes de domínio/eventos e OutboxMessage da AR02 e seus testes de contratos permanecem preservados. Wagering/outbox/consumer receberam somente instrumentação nos pontos listados; a integração AR01/AR02 passou integralmente. Hashes em [ar09-source-before.json](ar09-source-before.json) e [ar09-verification.json](ar09-verification.json).
- Somente fixtures exclusivos foram criados/limpos pelas suítes. Não houve alteração em dados compartilhados, remoção de volumes, docker compose down, reinício de containers, instalação de dependências, commit ou push. Reinício/parada foram limitados aos processos filhos criados pelo teste. `compose.app.yaml` foi preparado como configuração, sem aplicação ao ambiente compartilhado.

AR09 está corrigido e comprovado no ambiente isolado. Isso não certifica ausência de todas as outras pendências de arquitetura nem executa rollout em serviços existentes.
