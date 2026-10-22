# AR02 — contratos dos eventos de integração

**Resultado: PASS — 79 testes executados e aprovados, 0 FAIL, 0 BLOCKED. Os mesmos 65 casos anteriores passaram novamente, acrescidos de 11 unitários e 3 integrações AR02. Vinte assertions negativas de TypeScript também passaram na compilação do projeto.** Execuções em 2026-10-21; PostgreSQL e LocalStack reais em fixtures exclusivos. Nenhuma implantação nem alteração de dados compartilhados.

## Diagnóstico e evidência anterior

Lidos a seção 11 integral do README prioritário, ARCHITECTURE, relatório 02-EVENTOS-TIPAGEM, AR02 do CSV, domínio, contratos, produtores, consumidor SQS, persistência/publicação da outbox e testes associados.

| Fronteira anterior | Deficiência encontrada | Correção |
|---|---|---|
| As quatro subclasses e suas factories, events.ts antigo:26–57 | `IntegrationEvent<Record<string, unknown>>` e entrada `Record<string, unknown>` não exigiam campos próprios de cada evento | Interfaces distintas, factories tipadas/validadas, construtores privados, discriminadores literais |
| `emit` em wagering.ts antigo:79–88 | Voltava a apagar o contrato específico como `IntegrationEvent<Record<string, unknown>>` | União fechada `WagerIntegrationEvent` |
| `OutboxMessage.payload` e `rehydrate` | Record genérico dizia representar qualquer JSON, sem reconstrução validada | `StoredIntegrationEvent`; entrada de persistência `unknown` validada integralmente |
| `OutboxMessage.enqueue` | Aceitava serializer estrutural parcial, sem exigir data/version/correlationId | Aceita somente a união de eventos concretos e valida o envelope |
| Publisher | Query sem tipo de payload e envio direto do JSON armazenado | Linha com payload unknown, reidratação, conferência de identidade e publicação tipada |
| Teste unitário antigo de evento/backoff | WalletBalanceChanged criado só com money, sem os demais seis campos obrigatórios | Fixture completo; todas as asserções anteriores mantidas |

Os produtores financeiros existentes já usavam `Money.toJSON()`; **não foi constatado que publicassem atualmente Money ou bigint indevido**. A deficiência era a ausência de garantia: as factories aceitavam Money, bigint, números, campos ausentes e discriminadores incompatíveis. A serialização própria de Money podia ocultar a entrada errada; um bigint arbitrário podia falhar na serialização.

Antes de alterar os contratos, foram adicionados 12 casos negativos em `test/types/events.contracts.ts`. `bunx --no-install tsc --noEmit` retornou **exit 2, 12 TS2578**, porque todas as diretivas `@ts-expect-error` estavam não utilizadas: as entradas inválidas eram aceitas. Este é um diagnóstico negativo esperado, registrado como **FAIL do contrato anterior**, não como teste de aplicação aprovado. [Log completo](../logs/ar02-types-before.stdout.log), [metadados](../logs/ar02-types-before.result.json).

Também foram capturados cinco envelopes pelas factories **anteriores à correção**, incluindo Processed de OPENING sem status, Processed de LOSS, Rejected, PendingReference e BalanceChanged: [events-v1-legacy.json](../../../test/fixtures/events-v1-legacy.json). [Registro da captura](../logs/ar02-capture-before.stdout.log). Não se leu nem transformou payload de filas/banco compartilhados para produzir esses fixtures.

## Contratos adotados

Todos os eventos preservam `eventId`, `aggregateId`, `correlationId`, `causationId` opcional, `occurredAt` ISO-8601, `eventType`, `version` e `data`. Cada classe concreta define literalmente seu próprio eventType e `version = 1`. Base abstrata e constructors/factories continuam respeitando a seção 11.

| Evento | Campos obrigatórios de data | Campo opcional e compatibilidade |
|---|---|---|
| WagerTransactionProcessed | transactionId:string, kind:Kind, balance:MoneyProps | status?:"PROCESSED"; OPENING v1 já o omitia |
| WagerTransactionRejected | transactionId:string, kind:Kind, balance:MoneyProps, status:"REJECTED", failureCode:string não vazio | Nenhum dado novo obrigatório |
| WagerTransactionPendingReference | transactionId:string, kind:Kind, balance:MoneyProps, status:"PENDING_REFERENCE" | Nenhum dado novo obrigatório |
| WalletBalanceChanged | walletId:string, transactionId:string, direction:"CREDIT" ou "DEBIT", money:MoneyProps, balanceBefore:MoneyProps, balanceAfter:MoneyProps, walletVersion:inteiro positivo | Os sete campos do exemplo oficial |

Kind permanece OPENING/BET/WIN/LOSS/REFUND/ROLLBACK. Não se inventou campo de negócio adicional obrigatório para Processed/Rejected/PendingReference: os contratos formalizam os dados que os produtores anteriores já emitiam. Status é implícito no tipo de Processed e, quando fornecido, só pode ser PROCESSED; sua opcionalidade preserva a forma antiga de OPENING sem normalização artificial.

MoneyProps contém somente amount:string decimal canônica não negativa de duas casas e currency:string reconhecida pelo domínio. A validação reutiliza `Money.from` sem modificar Money nem suas regras. A factory rejeita uma instância Money, amount numérico, bigint, notação científica, escala excedente e moeda inválida; o tipo também rejeita as incompatibilidades representáveis estaticamente. Validação monetária não faz arredondamento nem converte number em dinheiro.

Contexto e dados validados são snapshots; estruturas monetárias são readonly/congeladas e a data de ocorrência é serializada de um timestamp estável. Isso mantém a idempotência de `toJSON` mesmo quando o chamador muda objetos de entrada ou uma cópia de Date. Metadados permitidos são copiados explicitamente, sem aceitar eventType/version extras pelo contexto. Não houve refatoração geral dos demais modelos ou correção independente dos outros achados.

## Produtor → persistência → publicação

1. Factories privadas/concretas recebem payloads específicos e validam entradas também em runtime.
2. `emit` recebe a união `WagerIntegrationEvent`; `OutboxMessage.enqueue` grava a união discriminada por eventType, mantendo a relação entre tipo do evento e data.
3. PostgreSQL continua armazenando JSONB no schema existente. A fronteira de leitura recebe **unknown**, sem cast que declare JSON não verificado como válido.
4. `parseIntegrationEvent` valida envelope, versão, campos obrigatórios, dinheiro, status e dados específicos. `rehydrate` confere também eventId/aggregateId/eventType contra as colunas correspondentes da outbox.
5. Somente depois disso `sendIntegrationEvent(StoredIntegrationEvent)` publica para SQS, usando aggregateId como MessageGroupId e eventId como MessageDeduplicationId.

O helper genérico `send` continua atendendo as mensagens de entrada WagerTransactionRequested, que são outro contrato e não um dos quatro eventos de saída. O consumidor de entrada não foi refatorado; continua chamando o mesmo use case, deduplicando pela inbox e confirmando após commit. O teste real de entrada/publicação comprova esse percurso com os contratos novos.

Falha de contrato na leitura fica no tratamento de retry já existente do publisher: não há send, published_at continua NULL, attempts aumenta e next_attempt_at recebe backoff. O payload permanece idêntico para diagnóstico. Isso não implementa AR09 nem transforma a outbox em nova DLQ; a operação de investigar/corrigir dados inválidos continua fora desta entrega.

## Compatibilidade e alteração anunciada

Antes de editar o código foi informado ao usuário que **a API TypeScript das factories deixaria de aceitar payload parcial**, e que o fixture antigo incompleto seria completado sem remover asserções. Essa restrição é deliberada e necessária a AR02; não há promessa de compatibilidade de chamadas inválidas a Record.

O **formato válido de mensagens já produzidas permanece versão 1**. Não foram adicionados campos obrigatórios ao JSON anterior nem criada migration. Em especial, OPENING continua sem status, causationId continua opcional, e eventId/occurredAt/aggregateId/correlationId/data não são regenerados ao reidratar. A ordem das propriedades de JSONB não é contrato; os testes comparam todos os valores do envelope, não a ordem textual.

Os cinco fixtures antigos passaram na validação/reidratação e foram inseridos apenas na outbox de teste e efetivamente recebidos da fila de eventos LocalStack com os mesmos dados. Versão desconhecida, campo extra não contratado, payload incompleto e identidade divergente agora são recusados e retidos para retry, sem descarte, migração silenciosa ou envio incompatível. Não se afirma compatibilidade com dados arbitrários incorretos que o tipo Record permitia construir; a compatibilidade demonstrada é com os envelopes válidos dos produtores anteriores.

## Arquivos e linhas

| Arquivo | Ponto relevante | Alteração |
|---|---|---|
| [src/domain/events.ts:9](../../../src/domain/events.ts#L9) | Interfaces e união discriminada | Quatro payloads, envelope tipado, schemas, parser e classes concretas |
| [src/domain/events.ts:148](../../../src/domain/events.ts#L148) | parseIntegrationEvent | Validação explícita do JSON de persistência/broker |
| [src/domain/events.ts:151](../../../src/domain/events.ts#L151) | IntegrationEvent e subclasses | Metadados, snapshot, data readonly, eventType/version concretos e constructors privados |
| [src/domain/messages.ts:54](../../../src/domain/messages.ts#L54) | OutboxMessage | Payload tipado, enqueue restrito, rehydrate unknown validado e identidade conferida |
| [src/application/wagering.ts:79](../../../src/application/wagering.ts#L79) | emit e produtores em :474 | União de eventos; cada branch produz status/failureCode do seu contrato; OPENING preservado |
| [src/infrastructure/outbox.ts:17](../../../src/infrastructure/outbox.ts#L17) | Claim e publicação em :25 | JSON unknown reidratado antes de enviar; claims/leases e métricas preservados |
| [src/infrastructure/sqs.ts:71](../../../src/infrastructure/sqs.ts#L71) | sendIntegrationEvent | Fronteira de publicação recebe a união validada |
| [test/unit/domain.test.ts:143](../../../test/unit/domain.test.ts#L143) | Caso anterior de evento/backoff | Somente o argumento incompleto virou payload completo; asserções mantidas |
| [test/types/events.contracts.ts:12](../../../test/types/events.contracts.ts#L12) | Assertions estáticas | Vinte incompatibilidades específicas e assertions positivas de literais/string |
| [test/unit/events.test.ts:48](../../../test/unit/events.test.ts#L48) | Onze casos novos | Envelopes completos, dinheiro, JSON, reconstrução, compatibilidade e identidade |
| [test/integration/events.test.ts:36](../../../test/integration/events.test.ts#L36) | Três casos novos | Produtores financeiros, consumidor/publicação reais e retenção de inválidos |
| [test/fixtures/events-v1-legacy.json](../../../test/fixtures/events-v1-legacy.json) | Cinco mensagens antigas | Capturadas antes da correção; prova de compatibilidade |
| ARCHITECTURE.md, seção Limitações | Descrição antiga de Record genérico | Atualizada apenas para explicar AR02 e a compatibilidade v1 |

Sem alteração de README oficial, package.json, bun.lock, tsconfig, modelo financeiro, consumidor de entrada, runner de migrations ou migrations 001, 002 e 003. AR01 permanece validada pela suíte. AR09 permanece pendente: não foi acrescentado exporter/endpoint de métricas a workers nem alterada a semântica dos contadores.

## Testes e evidências reais

### Tipos — PASS após a correção

O arquivo de assertions faz parte do include original de tsconfig; não há ts-ignore, ts-nocheck, relaxamento de strict ou exclusão do projeto. `@ts-expect-error` é aplicado somente à linha incompatível esperada; se uma regressão voltar a aceitar o payload, TS2578 fará a compilação falhar. A função de assertions não é executada pelo Bun e não envia mensagens.

Cobertura estática: os quatro payloads incompletos; Money em money e balance; amount bigint/number; currency ausente; direção/tipo de transação/versão da wallet inválidos; failureCode ausente ou numérico; status Processed/Pending incompatíveis; constructor privado; serializer parcial na outbox; data incompatível com eventType na publicação; mutação de MoneyProps readonly. Assertions positivas preservam eventType literal, version literal1 e amount:string.

### Testes automatizados — PASS

- **11 unitários novos/160 asserções:** quatro casos de envelope completo; causationId opcional e OPENING sem status; snapshot/ausência de bigint ou Money; campos obrigatórios; validações monetárias; envelope/versão inválidos; fixtures legados; identidade da outbox.
- **3 integrações novas/177 asserções:** eventos emitidos por OPENING/BET/WIN/LOSS/REFUND/ROLLBACK/rejeição/PENDING_REFERENCE e resolução da referência; consumidor SQS real com redelivery sem segundo débito/evento; publicação e recebimento dos payloads novos/antigos; inválidos persistidos permanecem sem publicação e com backoff.
- **Regressão completa:** 38 unitários/223 asserções, 38 integrações/384 asserções, 3 concorrência/21 asserções. Os testes de três processos, 50 duplicatas, disputa de saldo, crash/recovery, A01/A02/A03 e AR01 passaram novamente. Nenhum teste anterior removido.

Não se somam as execuções focadas nem as assertions de tipos ao total de 79 casos distintos. A comparação por arquivo+nome do log atual com a lista da execução AR01 confirmou **65 identificados e os mesmos 65 PASS atuais**, sem reutilizar aprovação anterior. [ar02-verification.json](ar02-verification.json) contém identidades, hashes e os metadados dos comandos.

### Comandos via PowerShell

Horários UTC em 2026-10-21. O runner existente preserva stdout e stderr completos; cada `.result.json` aponta para os dois logs homônimos, além de horário, duração e exit code.

| Comando | Início UTC | Duração | Exit | Resultado | Evidência |
|---|---|---:|---:|---|---|
| `bun docs/audit/architecture/ar02-capture-before.ts` | 17:55:06.924 | 0.594 s | 0 | Captura de cinco fixtures anteriores | [capture-before.result.json](../logs/ar02-capture-before.result.json) |
| `bunx --no-install tsc --noEmit` antes da correção | 17:55:09.005 | 6.295 s | 2 | FAIL esperado: 12 contratos inválidos aceitos/TS2578 | [types-before.result.json](../logs/ar02-types-before.result.json) |
| `bun test test/unit/events.test.ts` | 18:03:56.428 | 0.848 s | 0 | 11 PASS | [unit-focused.result.json](../logs/ar02-unit-focused.result.json) |
| `bun test test/integration/events.test.ts --timeout 60000` | 18:03:58.813 | 4.676 s | 0 | 3 PASS, PostgreSQL/SQS reais | [integration-focused.result.json](../logs/ar02-integration-focused.result.json) |
| `bun run test:all` | 18:04:56.917 | 34.463 s | 0 | Typecheck e 79 PASS/0 FAIL | [test-all.result.json](../logs/ar02-test-all.result.json) |
| `bun run format:check` | 18:04:57.488 | 1.380 s | 0 | PASS | [format.result.json](../logs/ar02-format.result.json) |
| `bunx --no-install tsc --noEmit` depois da correção | 18:04:58.181 | 6.457 s | 0 | PASS com 20 assertions negativas ativas | [typescript.result.json](../logs/ar02-typescript.result.json) |
| `bun docs/audit/architecture/ar02-evidence.mjs` | 18:06:29.271 | 1.404 s | 0 | PASS: identidades e preservação | [evidence.result.json](../logs/ar02-evidence.result.json) |

[Log completo do runner Bun](../logs/ar02-test-all.stderr.log) e [stdout completo](../logs/ar02-test-all.stdout.log). Falhas de contrato injetadas nos testes geram outbox_retry deliberadamente; não são reprovações escondidas.

## Preservação e limites

Todos os acessos de integração e injeções de payload inválido foram limitados aos schemas/roles/filas aleatórios dos fixtures existentes. Os testes anteriores de reversão de migrations continuam restritos ao schema descartável de teste; nenhuma migration destrutiva foi executada contra dados existentes/compartilhados. Esta correção não adiciona nem aplica migration financeira. Limpeza das suítes remove somente fixtures próprios.

Os hashes anteriores à edição e os atuais estão em [ar02-source-before.json](ar02-source-before.json) e [ar02-verification.json](ar02-verification.json). Entre fontes existentes mudaram somente os sete arquivos listados de implementação/documentação/fixture unitário. Preservados migrations001–003, correção AR01, contratos HTTP/entrada SQS, modelo financeiro, observability.ts/main.ts/worker.ts, configurações, scripts e infraestrutura. Modificações em outbox/sqs são exclusivamente de contrato/validação/publicação; AR09 não foi implementada.

Não houve instalação de dependências, commit, push, remoção de volumes, restart ou alteração dos serviços compartilhados. Os relatórios históricos da auditoria permanecem históricos. Compatibilidade foi exercitada com os cinco formatos válidos capturados; não se afirma validação de toda mensagem arbitrária já produzida nem eliminação das outras pendências de arquitetura.
