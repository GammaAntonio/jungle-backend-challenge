# Preparação final da entrega

**Classificação: PRONTO PARA VERSIONAMENTO.** A revisão documental, o inventário e a validação desta etapa não encontraram segredo real, arquivo essencial ausente ou falha nos checks repetidos. Essa classificação autoriza preparar um commit para revisão manual; não significa que houve commit/publicação nem que o projeto foi aprovado pela Jungle.

## Estado e escopo

O produto contém API HTTP e workers para processar BET, WIN, LOSS, REFUND e ROLLBACK com dinheiro exato, idempotência persistida, transações PostgreSQL, ledger imutável, inbox/outbox, SQS, observabilidade e migrations reversíveis. O domínio, decisões e comandos estão em `ARCHITECTURE.md` e `docs/SETUP.md`.

O README oficial da Jungle foi comparado por `git diff`: seu texto normativo e critérios permanecem intactos; a única alteração atual é um apêndice curto de links locais para setup, arquitetura, testes e status. A cópia do desafio anterior ao apêndice está em `docs/CHALLENGE_ORIGINAL.md`.

## Estrutura essencial

- `src/`: domínio, aplicação, API e adaptadores PostgreSQL/SQS.
- `migrations/`: migrations incrementais com `up` e `down`.
- `scripts/`: provisionamento, migrations, filas, métricas e processos de teste.
- `test/`: unitários, contratos de tipos, integração e concorrência.
- `Dockerfile`, `compose.yaml` e `compose.app.yaml`: imagem, infraestrutura base e aplicação.
- `docs/`: setup, resultados históricos, arquitetura, status e relatórios selecionados.

## Instalação e execução

Pré-requisitos: Docker Desktop com containers Linux e Bun 1.4.3 para executar comandos no host. Em uma máquina limpa, copie `.env.example` para `.env` e use as instruções de `docs/SETUP.md`. O caminho Compose padrão sobe PostgreSQL 16 e LocalStack, depois o serviço init provisiona a role runtime, executa migrations pela conexão administrativa e cria as filas. API e worker podem ser executados no host ou via `compose.app.yaml`; para escala Compose, use três réplicas de cada serviço conforme o setup. Não reutilize uma base ou projeto Compose que contenha dados de outro ambiente.

Os testes de integração/concorrência criam schemas, roles de teste e filas com prefixos aleatórios. `bun run test:all` executa typecheck e as três categorias de teste; também estão disponíveis `bun run format:check` e `bunx --no-install tsc --noEmit`. O README contém contratos e exemplos oficiais; `docs/SETUP.md` contém exemplos PowerShell de wallet, submissão, replay e reconciliação.

## Validação desta etapa

Os comandos foram executados nesta etapa em PowerShell, usando somente o projeto descartável `jungle-durability-10c26e`, PostgreSQL/LocalStack próprios e portas dinâmicas:

| Verificação | Resultado observado | Duração |
|---|---:|---:|
| `bun run format:check` | PASS — todos os arquivos `src`, `scripts` e `test` passam Prettier | 2,12 s |
| `bunx --no-install tsc --noEmit` | PASS — exit code 0 | 11,37 s |
| `bun run test:all` | PASS — 45 unitários, 60 integração e 3 concorrência; 108 aprovados, 0 falhas | 105,10 s |

O log integral de `test:all` está em `docs/audit/homologation/logs/etapa8-test-all.log`; o caminho é ignorado pelo Git como evidência local. A suíte executou com PostgreSQL e LocalStack reais do projeto isolado, sem reiniciar ou remover volumes. Esses resultados são da validação desta etapa. Os cenários maiores da homologação (três APIs e três workers) continuam documentados como históricos na `docs/audit/homologation/RELATORIO-FINAL.md`.

## Recuperação e limitação conhecida

A outbox é gravada atomicamente com o commit financeiro. A indisponibilidade/crash do publisher antes do envio deixa o evento pendente; outra instância o publica e replay financeiro é protegido por idempotência. Esse cenário do README foi reproduzido em infraestrutura isolada e passou.

O teste adicional que reinicia o LocalStack Community 4.6.0 depois da confirmação do SQS falhou: a edição perdeu fila/mensagens enquanto o PostgreSQL manteve as linhas com `published_at`. A aplicação não república automaticamente mensagens que o broker aceitou e que depois desapareceram. A falha permanece registrada, não é contada entre os 108 testes e não deve ser ocultada nem declarada PASS. `DECISAO-DURABILIDADE.md` conclui que o resultado, por si só, não demonstra falha no cenário obrigatório do README nem na durabilidade do serviço AWS SQS. A entrega depende da durabilidade contratual do broker após confirmação; não se afirma durabilidade pós-aceitação contra perda arbitrária do broker.

## Segurança e arquivos locais

A busca em arquivos candidatos não encontrou `.env` privado, token AWS/LocalStack, chave privada, certificado ou segredo de produção. Valores encontrados nos exemplos e Compose são credenciais locais de desenvolvimento (`jungle_dev`, role runtime e credenciais SQS `test`); não os reutilize fora da máquina de desenvolvimento. O projeto de homologação usa placeholders substituídos em arquivo temporário externo ao repositório.

O `.gitignore` agora exclui dependências, `.env` privados, cobertura, logs, dumps, estados da homologação e saídas JSON/JSONL brutas da auditoria. `.dockerignore` também exclui `.env`, `.git` e artefatos de auditoria do contexto de imagem. Nenhum `git add`, commit, push, reset ou alteração de remoto foi executado; branch atual: `desenvolvimento`.

## Lista recomendada para versionamento

O conjunto recomendado contém **74 arquivos**. Para manter a lista reproduzível e evitar dezenas de nomes redundantes, ela é definida pelas categorias abaixo; todas as contagens foram calculadas da árvore atual:

1. **12 arquivos da raiz:** `.dockerignore`, `.env.example`, `.gitignore`, `ARCHITECTURE.md`, `Dockerfile`, `IMPLEMENTATION_STATUS.md`, `README.md`, `bun.lock`, `compose.app.yaml`, `compose.yaml`, `package.json`, `tsconfig.json`.
2. **45 arquivos de implementação e teste:** todos os arquivos versionáveis sob `migrations/`, `scripts/`, `src/` e `test/`, incluindo `test/fixtures/events-v1-legacy.json`.
3. **17 documentos/configurações selecionados:** `docs/CHALLENGE_ORIGINAL.md`, `docs/SETUP.md`, `docs/TEST_RESULTS.md`, `docs/ENTREGA-FINAL.md`, `docs/audit/CORRECOES.md`, `docs/audit/architecture/AR01-CORRECAO.md`, `docs/audit/architecture/AR02-CORRECAO.md`, `docs/audit/architecture/AR09-CORRECAO.md`, `docs/audit/manual/CORRECAO-PAGINACAO-LEDGER.md`, `docs/audit/homologation/compose.yaml`, `docs/audit/homologation/.env.example`, `docs/audit/homologation/http-smoke.ps1`, `docs/audit/homologation/sqs-e2e.ts`, `docs/audit/homologation/sqs-tool.ts`, `docs/audit/homologation/RELATORIO-FINAL.md`, `docs/audit/homologation/LOCALSTACK-PERSISTENCIA.md` e `docs/audit/homologation/DECISAO-DURABILIDADE.md`.

Não adicionar em bloco o restante de `docs/audit/`: capturas JSON, logs de stdout/stderr, transcrições, scripts de reprodução temporários e estados de containers são evidência local, alguns contêm identificadores ou credenciais descartáveis e outros refletem snapshots antigos. O relatório `docs/audit/final-architecture/07-RELATORIO-FINAL.md` é uma fotografia estática anterior às correções de cursor/restart-check e à homologação; mantenha-o fora do pacote normativo para evitar apresentar achados superados como status atual. `Jungle_Codex_Prompt_Mestre.md` é artefato de instrução, não parte do produto. `sqs-attributes.json` é redundante: a inicialização idempotente cria as filas e o setup não depende desse arquivo. A linha `docs/test-all-output.log` e demais outputs locais permanecem ignorados.

## Pendências e submissão

Não há pendência essencial identificada que impeça preparar o versionamento. Permanecem limitações documentadas: persistência do LocalStack Community após restart, autenticação externa não implementada conforme opção permitida pelo README, e ausência de teste de carga/failover prolongado. O histórico de resultado **NÃO APTO** da homologação pelo probe adicional continua no relatório; o aditivo explica a decisão posterior e não apaga o FAIL observado.

O README fornecido não contém instruções específicas de formato, endereço ou procedimento de submissão; não presumimos um canal de entrega. Antes de publicar, revise manualmente a lista recomendada, examine o diff do apêndice local do README e confirme as instruções atuais recebidas da Jungle. Nenhum commit ou push foi feito nesta preparação.

## Checklist

- [x] Código, migrations, scripts e testes essenciais presentes.
- [x] Compose e Dockerfile coerentes com os comandos documentados.
- [x] `.env.example` contém somente credenciais placeholder locais.
- [x] Resultado atual de `format:check`, TypeScript e 108 testes registrado.
- [x] Limitação do LocalStack divulgada separadamente do cenário oficial de recuperação da outbox.
- [x] Logs e estados temporários ignorados no Git.
- [x] Branch `desenvolvimento` preservada; nenhum commit/push/reset feito.
- [ ] Revisão manual e aprovação da lista de arquivos antes do primeiro commit.
- [ ] Confirmar o canal de submissão com a Jungle.
