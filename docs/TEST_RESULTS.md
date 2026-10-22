# Resultados executados
## Homologação posterior

Em 21/10/2026, uma homologação limpa posterior executou **108 testes aprovados, zero falhas** (45 unitários, 60 integração e 3 concorrência), além de formatação e TypeScript aprovados. Essa execução usou PostgreSQL 16 e LocalStack em containers isolados, três APIs e três workers. É o resultado histórico da homologação limpa, detalhado em `docs/audit/homologation/RELATORIO-FINAL.md`. O teste adicional de persistência do LocalStack Community após perda de estado falhou e não está incluído nos 108 testes; consulte `docs/audit/homologation/DECISAO-DURABILIDADE.md`. A validação repetida durante a preparação final está registrada separadamente em `docs/ENTREGA-FINAL.md`.

Execução final das suítes em 2026-10-21 UTC (logs de integração/concorrência aproximadamente 02:40 UTC), no Windows/PowerShell, Bun 1.4.3, PostgreSQL 16 e LocalStack 4.6 reais em Docker. Nenhuma dependência financeira ou SQS foi substituída por mock.

| Comando | Resultado real |
|---|---|
| `bun install` | PASS, dependências resolvidas e bun.lock gerado |
| `bun run format:check` | PASS |
| `bun run test:all` / typecheck | PASS, TypeScript strict sem erros |
| `bun run test:unit` | PASS: 25 testes, 0 falhas |
| `bun run test:integration` | PASS: 17 testes, 0 falhas, 72 asserções, 25,66 s |
| `bun run test:concurrency` | PASS: 3 testes, 0 falhas, 21 asserções, 4,83 s |
| migrations up/down/up | PASS em schema isolado, dentro da integração |
| build Docker das imagens API/worker/init | PASS |
| Compose com 3 APIs e 3 workers | PASS; 3 APIs healthy, infraestrutura original healthy |
| restart PostgreSQL/API/worker + `restart-check.ts verify` | PASS: persistência, replay e reconciliação |

Total final: **45 testes aprovados, zero falhas**. A saída local integral de `test:all` foi salva em `docs/test-all-output.log` (artefato ignorado pelo Git). Os testes são reproduzíveis pelos comandos de `docs/SETUP.md`.

## Evidências cobertas

- Money exato, inválidos, escala, overflow, moedas, imutabilidade; Wallet/ledger e estados terminais; direções das cinco operações; inbox e backoff/versionamento de eventos.
- Abertura com OPENING/ledger e versão 1; unicidade da wallet, saldo não negativo, ledger imutável e alteração sem lastro rejeitada pelo banco.
- BET, WIN, LOSS, REFUND, ROLLBACK; dupla reversão, referência cruzada, moeda, valor divergente, saldo insuficiente em reversão, saldo original no replay e limite monetário.
- Referência fora de ordem processada quando disponível; expiração explícita por REFERENCE_TIMEOUT.
- Falha deliberada no commit após inserir inbox: rollback conjunto de wallet, transação, ledger, inbox e outbox.
- Conexão PostgreSQL terminada durante transação: registros não confirmados ausentes depois; reconciliação preservada.
- Inbox persistente e payload conflitante; entrega SQS real e redelivery sem segundo efeito.
- Dois publishers, inclusive processos separados; morte real do publisher depois de send, recuperação por lease e publicação posterior. A expiração da lease é antecipada no banco do teste para evitar espera arbitrária de 60 s.
- Morte real do consumidor após commit e antes do ack; redelivery e reconciliação por processo novo.
- Poison message recebida exatamente cinco vezes antes da DLQ real.
- SQS indisponível por conexão TCP recusada: outbox fica pendente com tentativas; publisher saudável publica depois.
- NestJS real em processo filho: ready, validação 400, conflito 409, rejeição 422, pending 202, paginação e cursor.
- 50 envios idênticos distribuídos entre três processos independentes com barreira READY/GO: um transactionId, exatamente um débito, somente um primeiro processamento.
- Duas BET 80.00 disputando wallet 100.00: uma PROCESSED, outra INSUFFICIENT_FUNDS, saldo final 20.00; terceiro processo movimenta outra wallet.
- Payloads conflitantes simultâneos: um único processamento, outro conflito; ledger reconciliado.
- Restart físico de PostgreSQL, APIs e workers: schema de teste preservou transactionId, replay e saldo 75.00. A verificação removeu somente seu schema isolado.

## Histórico e limites

As primeiras execuções de integração revelaram incompatibilidade de parâmetro uuid/text na abertura, tratamento do retorno UPDATE/RETURNING pelo TypeORM e retomada indevida de estado PENDING_REFERENCE. Foram corrigidas antes da execução final. Houve também uma execução intermediária em que a migration foi alterada durante a suíte, causando falha no down; a execução completa posterior passou com o conjunto final consistente.

Não foram executados benchmark de carga, partição de rede prolongada, failover PostgreSQL ou integração com IdP (opcionais/limitações documentadas). A falha SQS usa porta TCP indisponível, não queda prolongada do serviço compartilhado. A configuração de DLQ é real; testes aceleram visibilidade para observar os cinco recebimentos. A prova de concorrência usa três processos e infraestrutura real, não três mocks ou execução sequencial.
