# Status da implementação

A especificação normativa é o README oficial. A raiz mantém o texto original e um apêndice curto com links para documentação da implementação; a cópia anterior ao apêndice está em `docs/CHALLENGE_ORIGINAL.md`.

## Estado atual

| Área | Estado | Evidência / limite |
|---|---|---|
| Dinheiro, wallet e regras financeiras | Implementado e exercitado | `Money` usa centavos `bigint`; operações e ledger usam PostgreSQL real, locks por wallet e constraints. |
| Idempotência e concorrência | Implementado e exercitado | Unicidade persistente, inbox, três processos independentes, replay e reconciliação. |
| Migrations e permissões | Implementado | Migrations reversíveis; role administrativa limitada a init/migrations; runtime sem privilégios de alteração/truncamento do ledger. |
| API e ledger | Implementado | Contratos HTTP, idempotency key, paginação opaca estável, health e reconciliação. |
| Eventos e mensageria | Implementado | Quatro eventos tipados, outbox transacional, publisher concorrente, inbox, retry e DLQ. Crash antes da publicação recupera a outbox. |
| Observabilidade | Implementado no escopo do desafio | Logs correlacionados e métricas por API/worker. Counters são locais ao processo; não há exporter Prometheus, tracing ou dashboard. |
| Autenticação | Não implementada deliberadamente | Permitido pela seção 2 do README; `ProviderIdentityPort` é ponto de extensão e o desenho OIDC está em `ARCHITECTURE.md`. Não usar a configuração permissiva como autenticação de produção. |
| Ambiente local | Reproduzível em Compose | PostgreSQL 16, LocalStack, init, API e worker; `compose.app.yaml` permite escalar APIs/workers. |

## Testes históricos

A última homologação completa registrada executou `bun run test:all` com **108 aprovados e zero falhas**: 45 unitários, 60 de integração e 3 de concorrência. Incluiu PostgreSQL e SQS em containers, três APIs e três workers, operações financeiras HTTP, concorrência, outbox/inbox, retry/DLQ e restart do serviço. TypeScript e `format:check` também passaram nessa execução. Isso é evidência histórica da revisão homologada, não resultado de uma execução nesta etapa de preparação. Os detalhes estão em `docs/audit/homologation/RELATORIO-FINAL.md` e `docs/TEST_RESULTS.md`.

## Critérios eliminatórios

Os oito critérios do README foram marcados PASS nos cenários executados na homologação. Isso não equivale a prova de todas as falhas possíveis nem substitui a avaliação da Jungle. A perda de estado do LocalStack Community 4.6.0 após restart foi observada em um teste adicional de durabilidade do emulador. A recuperação oficial da outbox com processo morto antes de publicar passou; a falha adicional e a dependência da durabilidade do broker após confirmação estão descritas em `docs/audit/homologation/DECISAO-DURABILIDADE.md`.

## Limitações

- Persistência do LocalStack Community 4.6.0 após restart/recriação não foi demonstrada e falhou no ensaio isolado. A falha do probe adicional permanece registrada; não se presume que AWS SQS tenha o mesmo comportamento. A implementação depende da durabilidade contratual do broker depois que `SendMessage` confirma e a outbox marca `published_at`.
- Não foram feitos teste de carga, failover prolongado de PostgreSQL, tracing, IdP ou dashboards; são limites/opções explicitados na arquitetura, não resultados aprovados.
- Contadores de métricas reiniciam com o processo e não substituem ledger/auditoria persistente.

Consulte `docs/SETUP.md` para iniciar e testar, `ARCHITECTURE.md` para decisões técnicas e `docs/ENTREGA-FINAL.md` para o checklist de versionamento.
