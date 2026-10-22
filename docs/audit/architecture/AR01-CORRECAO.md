# AR01 — integridade entre ledger, transação e wallet

**Resultado: falha reproduzida antes da correção; tentativa rejeitada depois da migration 003. Validação: 65 PASS, 0 FAIL, 0 BLOCKED; formatação e TypeScript aprovados.** Execuções reais em 2026-10-21, exclusivamente em fixtures isolados. Não houve implantação no schema compartilhado/public.

## Reprodução anterior à correção — CONFIRMADA

Em 2026-10-21T17:21:27.977Z, PostgreSQL 16.15, schema exclusivo `audit_ar01_1a7cd87c323444a188a4fd6c199082fc`, somente migrations 001/002, login runtime exclusivo sem superuser e sem TRUNCATE:

- Wallet A recebeu WIN/CREDIT de 10.00 válido; B começou em 0.00.
- A runtime atualizou B para 10.00 e inseriu CREDIT de 10.00 em B com o transaction_id da WIN de A, na mesma transação SQL.
- COMMIT aceito, sem erro (`00000`, successful completion; não é código retornado por exceção).
- Resultado: A 10.00, B 10.00; dois lançamentos para a mesma transação em wallets diferentes; ambos os saldos iguais às respectivas somas do ledger.

Causa: `UNIQUE(transaction_id,wallet_id)` permite pares diferentes; FKs individuais não relacionam a wallet da transação à wallet do ledger. O trigger diferido seleciona uma linha por transaction_id sem STRICT e pode validar a linha correta anterior, ignorando a associação indevida. O caminho HTTP não foi usado para explorar: a barreira relacional falhou para DML autorizado à runtime. A reprodução confirma a hipótese do achado histórico [AR01](achados.csv), fundamentado no README §§5, 6.2 e 6.4.

Evidências: [JSON anterior](ar01-before.json), [stdout](../logs/ar01-reproduction-before-02.stdout.log), [metadados do comando](../logs/ar01-reproduction-before-02.result.json). Comando PowerShell: `bun docs/audit/architecture/ar01-reproduce.ts`.

A primeira tentativa do auxiliar falhou antes do ataque com `42P08` (tipo inconsistente do parâmetro `$1` usado como UUID/text). O auxiliar foi corrigido com cast explícito, e a tentativa seguinte acima confirmou o defeito. O erro original está preservado em [ar01-reproduction-before.stdout.log](../logs/ar01-reproduction-before.stdout.log); não foi tratado como resultado do AR01. Não se modificou código de produção até obter a reprodução positiva.

## Correção incremental

Arquivos de implementação:

- [003.up.sql](../../../migrations/003.up.sql): adiciona `UNIQUE(id,wallet_id)` em `wager_transaction` e FK de `ledger(transaction_id,wallet_id)` para esse par.
- [003.down.sql](../../../migrations/003.down.sql): remove primeiro a FK e depois a constraint única adicionada. Não remove tabelas nem dados.
- [db.ts:60](../../../src/infrastructure/db.ts#L60): registra 003 após 002 no up e antes de 002 no down. O runner mantém a transação e o controle de versões existentes.

SQL da nova barreira:

```sql
ALTER TABLE wager_transaction
  ADD CONSTRAINT wager_transaction_id_wallet_unique UNIQUE (id, wallet_id);

ALTER TABLE ledger
  ADD CONSTRAINT ledger_transaction_wallet_fk
  FOREIGN KEY (transaction_id, wallet_id)
  REFERENCES wager_transaction (id, wallet_id);
```

A FK é imediata e validada sobre o histórico existente, sem `NOT VALID`. A chave primária da transação já torna id único; a nova constraint explicita o par que PostgreSQL exige como alvo da FK. Com esse vínculo e a UNIQUE(transaction_id,wallet_id) existente no ledger, uma transação não pode ganhar uma segunda linha em outra wallet, nem uma segunda linha na própria wallet. Os triggers anteriores continuam protegendo aritmética, direção, estado, moeda, continuidade e saldo reconstruído. Não foi necessário reescrever a função antiga: com o vínculo composto, não há outra linha legítima da mesma transação a encobrir um lançamento cruzado.

Nenhuma migration antiga foi modificada. A migration não tenta reparar inconsistências anteriores: se encontrar uma, falha com `23503`, preservando as linhas. Pelo runner, o up inteiro é transacional, inclusive a constraint única; não fica uma instalação parcial. O teste de histórico inconsistente também verifica a falha com savepoint/rollback e comparação integral das linhas.

Uma aplicação futura em base compartilhada exigirá avaliar a existência de dados incompatíveis e a janela de locks/validação do `ALTER TABLE`. Essa aplicação não foi realizada nesta tarefa. O down remove a nova garantia e retorna ao schema anterior; foi exercitado somente em fixture isolado.

## Reprodução depois da correção — PASS

Em 2026-10-21T17:24:50.468Z, schema novo `audit_ar01_3ce4aabf46b942b28fc332f6dbf1485a`, migrations 001/002/003 e outro login runtime restrito, o mesmo cenário produziu:

```text
SQLSTATE: 23503 (foreign_key_violation)
constraint: ledger_transaction_wallet_fk
insert or update on table "ledger" violates foreign key constraint "ledger_transaction_wallet_fk"
```

O erro ocorre no INSERT do ledger, antes do COMMIT. O diagnóstico já havia atualizado B dentro da transação; o ROLLBACK reverteu também essa atualização. Resultado: A 10.00/versão 2, B 0.00/versão 1, somente uma linha válida no ledger e zero associações entre wallets diferentes. Saldos continuam iguais às somas dos respectivos ledgers.

Evidências: [JSON corrigido](ar01-fixed.json), [stdout completo](../logs/ar01-reproduction-fixed.stdout.log) e [metadados](../logs/ar01-reproduction-fixed.result.json).

## Testes novos e preservação das regressões

Os dez casos estão em [test/integration/ar01.test.ts](../../../test/integration/ar01.test.ts). O fixture prepara DDL administrativamente, troca o DataSource do serviço para a role runtime e chama `connectRuntime`; as operações válidas do serviço e as tentativas adversariais executam com essa role. Somente testes de migration usam a conexão administrativa. Nenhum mock substitui PostgreSQL.

| Caso real | Esperado e observado | Resultado |
|---|---|---|
| `AR01 valid financial operations and replay use runtime and matching transaction-wallet ledger` | OPENING/BET/WIN/REFUND/ROLLBACK válidos, LOSS sem ledger, replay com saldo original 75.00, saldo final 85.00, versão 5, reconciliação consistente | PASS |
| `AR01 runtime rejects cross-wallet OPENING ledger with 23503 and rolls back balance` | FK composta rejeita; saldo/versão e ledger preservados | PASS |
| `AR01 runtime rejects cross-wallet BET ledger with 23503 and rolls back balance` | Mesmo erro e preservação para débito | PASS |
| `AR01 runtime rejects cross-wallet WIN ledger with 23503 and rolls back balance` | Mesmo erro e preservação para crédito | PASS |
| `AR01 runtime rejects cross-wallet REFUND ledger with 23503 and rolls back balance` | Mesmo erro e preservação para restituição | PASS |
| `AR01 runtime rejects cross-wallet ROLLBACK ledger with 23503 and rolls back balance` | Mesmo erro e preservação para reversão | PASS |
| `AR01 runtime still rejects missing transaction with 23503 and no balance change` | FK continua rejeitando identificador inexistente; rollback preserva saldo | PASS |
| `AR01 runtime still rejects duplicate ledger on the same wallet with 23505` | Unicidade anterior continua ativa; nenhum segundo crédito | PASS |
| `AR01 migration 003 down and up preserve existing financial history and restore validated composite FK` | Comparação das cinco tabelas antes/depois igual; FK restaurada convalidated=true; versões 001/002/003 | PASS |
| `AR01 migration 003 refuses inconsistent existing history with 23503 without deleting or rewriting rows` | Histórico legado inválido criado apenas em transação/schema exclusivos; up recusado; linhas idênticas após rollback ao savepoint | PASS |

O único ajuste em teste existente está em `test/integration/corrections.test.ts:89`: a lista esperada de migrations passa de `[001,002]` para `[001,002,003]`. Mantém a verificação exata das versões e todas as demais asserções; não enfraquece o teste da migration 002. Os três arquivos dos 45 testes originais não foram alterados.

Comparação dos logs por **arquivo + nome real**, usando a execução anterior apenas como lista de identidades: **55 casos anteriores identificados, os mesmos 55 PASS novamente**, mais os dez AR01. [ar01-verification.json](ar01-verification.json) registra a comparação e os hashes. Não se reutilizou aprovação anterior como resultado desta correção.

## Comandos e resultados reais

Comandos disparados por PowerShell; o runner existente salva stdout, stderr, exit code e horários separadamente em `docs/audit/logs/`. Horários abaixo em UTC. A duração é do comando completo, incluindo o processo PowerShell.

| Comando | Início UTC em 2026-10-21 | Duração | Exit | Resultado | Evidência completa |
|---|---|---:|---:|---|---|
| `bun docs/audit/architecture/ar01-reproduce.ts` | 17:21:27.513 | 0.801 s | 0 | Reprodução positiva da falha; integridade anterior FAIL | [ar01-reproduction-before-02.result.json](../logs/ar01-reproduction-before-02.result.json) |
| `bun docs/audit/architecture/ar01-reproduce.ts --fixed` | 17:24:49.953 | 0.861 s | 0 | Ataque bloqueado com 23503; PASS | [ar01-reproduction-fixed.result.json](../logs/ar01-reproduction-fixed.result.json) |
| `bun test test/integration/ar01.test.ts --timeout 60000` | 17:24:52.174 | 2.541 s | 0 | 10 PASS, 0 FAIL; 66 asserções | [ar01-focused.result.json](../logs/ar01-focused.result.json) |
| `bun run test:all` | 17:25:10.520 | 29.620 s | 0 | Typecheck e 65 PASS, 0 FAIL | [ar01-test-all.result.json](../logs/ar01-test-all.result.json) |
| `bun run format:check` | 17:25:10.504 | 1.193 s | 0 | Todos os arquivos conformes | [ar01-format.result.json](../logs/ar01-format.result.json) |
| `bunx --no-install tsc --noEmit` | 17:25:10.510 | 5.400 s | 0 | Sem erros | [ar01-typescript.result.json](../logs/ar01-typescript.result.json) |
| `bun docs/audit/architecture/ar01-evidence.mjs` | 17:26:28.283 | 0.389 s | 0 | Preservação e identidades conferidas | [ar01-evidence.result.json](../logs/ar01-evidence.result.json) |

Cada arquivo `.result.json` aponta para seu `.stdout.log` e `.stderr.log` homônimos. [Log completo da suíte](../logs/ar01-test-all.stderr.log): **27 unitários/63 asserções, 35 integração/207 asserções e 3 concorrência/21 asserções**. Os três casos de concorrência, incluindo 50 duplicatas em três processos e disputa 80/80 sobre saldo 100, passaram com a migration nova. A execução focada e o diagnóstico são adicionais e não devem ser somados como novos casos ao total de 65.

A primeira execução do auxiliar, com erro42P08, permanece registrada com exit1 em `ar01-reproduction-before.result.json`; não foi ocultada nem incluída como teste de aplicação FAIL.

## Isolamento e limites

- Nenhuma migration foi aplicada ao schema compartilhado/public. Não houve reinício/remoção de containers, remoção de volumes, instalação de dependências, commit ou push.
- Os diagnósticos não executaram DROP, DELETE ou TRUNCATE. Seus três schemas exclusivos foram retidos: `audit_ar01_c4701b3b357a4fcb86d4d7df7954fbc8` (primeira tentativa, sem dados financeiros confirmados), `audit_ar01_1a7cd87c323444a188a4fd6c199082fc` (reprodução positiva) e `audit_ar01_3ce4aabf46b942b28fc332f6dbf1485a` (correção). Roles correspondentes também foram retidas; senhas aleatórias não são persistidas em logs.
- As suítes originais limpam somente os schemas/roles/filas que elas próprias criam. Seus testes de down/imutabilidade e remoção de fixtures foram executados no isolamento previsto; nenhum dado existente compartilhado foi apagado. O cenário novo de histórico inválido cria schema/dados dentro de uma transação e faz rollback integral desse fixture não confirmado.
- SHA256 compara as fontes com a captura anterior às alterações: migrations 001/002, scripts, package/lock, infraestrutura, README/ARCHITECTURE e arquivos de AR02/AR09 preservados. Entre fontes anteriores, somente `src/infrastructure/db.ts` e a lista esperada de versões em `test/integration/corrections.test.ts` mudaram. Acrescentados migration003 up/down e o novo arquivo de testes. Relatórios históricos da auditoria permanecem intactos.
- **AR02 e AR09 não foram corrigidos nem alterados.** Esta entrega resolve AR01 no schema/código testado e não declara o sistema integralmente correto. Aplicação da migration a instâncias compartilhadas permanece não executada.

Para reproduzir novamente, com PostgreSQL disponível e credencial administrativa autorizada para fixtures, os dois comandos do diagnóstico criam **novos** schemas/roles exclusivos e não tocam os fixtures antigos. A suíte completa usa PostgreSQL/LocalStack reais e seus prefixos próprios. Não execute o down completo em base com dados a preservar.
