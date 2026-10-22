# Distributed Wagering Processor

Implementação do desafio de backend da **Jungle Gaming**: processamento financeiro de apostas com múltiplas instâncias, persistência transacional e processamento assíncrono de eventos.

> **Enunciado original:** [docs/CHALLENGE_ORIGINAL.md](docs/CHALLENGE_ORIGINAL.md) · [Repositório do desafio](https://github.com/junglegaming/backend-challenge)

## Visão geral

A aplicação recebe operações de provedores de jogos e mantém o saldo das carteiras consistente com um ledger auditável. O domínio contempla **BET**, **WIN**, **LOSS**, **REFUND** e **ROLLBACK**, incluindo transações repetidas, referências fora de ordem e concorrência entre instâncias.

As garantias financeiras são persistidas no PostgreSQL, sem depender exclusivamente de memória local ou das propriedades da fila.

## Stack

- **Bun 1.x**, **TypeScript** estrito e **NestJS**
- **PostgreSQL** com **TypeORM**, migrations versionadas e reversíveis
- **AWS SQS** em ambiente local com **LocalStack**
- **Docker Compose** para infraestrutura, API e workers

## Decisões técnicas

- **Dinheiro exato:** valores recebidos e serializados como strings decimais, tratados por objeto de domínio.
- **Idempotência persistente:** reenvios da mesma operação não movimentam o saldo novamente; payloads conflitantes são rejeitados.
- **Concorrência por carteira:** transações e constraints do banco protegem saldo e ledger.
- **Ledger imutável:** lançamentos auditáveis e reconciliação entre saldo materializado e histórico.
- **Inbox e outbox transacionais:** processamento idempotente e publicação após o commit, com recuperação de eventos ainda pendentes.
- **Mensageria:** SQS, retries, DLQ e processamento distribuído por workers.

Detalhes e justificativas: [ARCHITECTURE.md](ARCHITECTURE.md).

## Execução local

**Pré-requisito:** Docker Desktop com containers Linux. Para executar ferramentas no host, utilize Bun (veja versões e configurações em [docs/SETUP.md](docs/SETUP.md)).

Na raiz do projeto:

```powershell
docker compose -f compose.yaml -f compose.app.yaml up -d --build --scale api=3 --scale worker=3
docker compose -f compose.yaml -f compose.app.yaml ps
docker compose -f compose.yaml -f compose.app.yaml port --index 1 api 3000
```

O Compose inicia a infraestrutura, o processo de provisionamento e **três APIs e três workers**. Cada API recebe uma porta dinâmica; o último comando informa a porta da primeira réplica.

Para interromper somente a aplicação:

```powershell
docker compose -f compose.yaml -f compose.app.yaml stop api worker
```

**Não remova volumes** de ambientes com dados que precisam ser preservados. Configuração por `.env`, execução no host, exemplos HTTP, reconciliação e ambiente descartável de homologação estão documentados em **[docs/SETUP.md](docs/SETUP.md)**.

## Testes

Com Bun e dependências instaladas, e com PostgreSQL/LocalStack isolados configurados conforme o setup:

```powershell
bun install --frozen-lockfile
bun run format:check
bunx --no-install tsc --noEmit
bun run test:all
```

Na última validação registrada, foram aprovados **108 testes automatizados**, sendo **45 unitários, 60 de integração e 3 de concorrência**, sem falhas nessa suíte. Esses resultados não abrangem todos os testes exploratórios executados durante a homologação.

Evidências e escopo: [resultados dos testes](docs/TEST_RESULTS.md) e [relatório de homologação](docs/audit/homologation/RELATORIO-FINAL.md).

## Limitações conhecidas

- **LocalStack Community 4.6.0:** um teste adicional de reinicialização do emulador encontrou perda de filas/mensagens previamente aceitas. A aplicação não recupera automaticamente eventos que o broker confirmou e posteriormente perdeu. **Esse teste falhou e não faz parte dos 108 testes aprovados.**
- **Recuperação da outbox:** a falha após o commit e **antes da publicação**, seguida da retomada por worker, foi reproduzida e aprovada em ambiente isolado. Isso não equivale à recuperação após perda do estado do broker.
- **Autenticação externa:** não integrada, conforme alternativa permitida no desafio; a decisão e o ponto de extensão estão documentados na arquitetura.
- Não foram demonstrados benchmark prolongado de carga ou failover completo de infraestrutura em produção.

Veja [decisão sobre durabilidade](docs/audit/homologation/DECISAO-DURABILIDADE.md) e [diagnóstico do LocalStack](docs/audit/homologation/LOCALSTACK-PERSISTENCIA.md).

## Documentação

| Documento | Conteúdo |
| --- | --- |
| [Enunciado original](docs/CHALLENGE_ORIGINAL.md) | Requisitos fornecidos pela Jungle Gaming |
| [Arquitetura](ARCHITECTURE.md) | Modelagem, transações, idempotência e decisões |
| [Instalação e execução](docs/SETUP.md) | Setup Docker/host e exemplos de API |
| [Resultados dos testes](docs/TEST_RESULTS.md) | Cenários e evidências |
| [Status da implementação](IMPLEMENTATION_STATUS.md) | Funcionalidades e ressalvas |
| [Relatório de entrega](docs/ENTREGA-FINAL.md) | Inventário e verificações finais |

---

Solução desenvolvida para o desafio técnico de Backend da Jungle Gaming.
