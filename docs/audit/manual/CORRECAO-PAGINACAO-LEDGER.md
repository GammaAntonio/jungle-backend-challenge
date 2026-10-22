# Correção isolada — paginação do ledger

**PASS após reprodução real da falha.** Em 21/10/2026: 10 regressões novas aprovadas; suíte completa **104 PASS / 0 FAIL** (41 unitários, 60 integração, 3 concorrência). Os mesmos 94 casos anteriores passaram novamente. TypeScript e formatação: PASS. A implementação mudou **uma expressão ORDER BY em uma linha**, sem alterar regras financeiras ou dados existentes.

## Insumos e isolamento

Foram lidos RELATORIO-15-25.md, resultados-15-25.csv, ARCHITECTURE.md e a seção 9 do README prioritário. O caminho solicitado **docs/audit/manual/final-summary.json não existe**; o arquivo existente lido é **docs/audit/manual/logs-15-25/final-summary.json**, referenciado no relatório anterior. Não foi criado substituto nem alterado o histórico da auditoria.

Reprodução e regressões usam PostgreSQL16/LocalStack reais dos containers existentes, schemas/roles/filas aleatórios de test/support.ts e API NestJS real em processo filho com porta dinâmica e role runtime restrita. A API do teste usa o código atual do workspace; nenhum container compartilhado foi reiniciado/recriado e nenhuma imagem foi reconstruída. O diagnóstico da carteira antiga foi somente leitura, em BEGIN READ ONLY no schema de auditoria preservado. Sem acesso de escrita a public, sem reescrita financeira, remoção de volumes, commit ou push.

## Dois lançamentos omitidos na auditoria original

Wallet **50a4a483-9b5c-4d80-80a7-0fd1db4e0a5c**, schema audit1525_82c25667f29c4437a564104ab2aa3d3f. Nova consulta PostgreSQL, nesta correção, confirmou que os sete lançamentos ainda existem. Omissões originais:

| Sequência | Ledger ID | Transaction ID | Kind / direção | Valor BRL / saldo |
| --- | --- | --- | --- | --- |
| 8 | efed7731-79e7-4d40-bfda-44bd6b1ea282 | b0e70f3e-7d00-4117-ba27-dd6218a212de | OPENING / CREDIT | 100.00 / 0.00 → 100.00 |
| 9 | 79b148ed-251b-41ed-8ab7-a5442012ae05 | f28d8124-69cc-456c-b29f-fd568b807f31 | BET / DEBIT | 25.00 / 100.00 → 75.00 |

Com limit=2, o primeiro cursor retornado era:

~~~text
eyJ3YWxsZXRJZCI6IjUwYTRhNDgzLTliNWMtNGQ4MC04MGE3LTBmZDFkYjRlMGE1YyIsInNlcXVlbmNlIjoiMTEifQ
~~~

Ele codifica walletId da consulta e sequence 11. O segundo cursor era:

~~~text
eyJ3YWxsZXRJZCI6IjUwYTRhNDgzLTliNWMtNGQ4MC04MGE3LTBmZDFkYjRlMGE1YyIsInNlcXVlbmNlIjoiMTMifQ
~~~

Ele codifica sequence 13. Percurso observado: **sem cursor → [10,11] → cursor11 → [12,13] → cursor13 → [14], nextCursor=null**. O predicado numérico sequence>11 excluiu8 e9 depois de a primeira página ter começado indevidamente em10. Todos os HTTP foram200: a omissão não produzia erro SQL/SQLSTATE. Consulta e EXPLAIN reais, com resultado completo e IDs: [diagnostico-sql.sql](logs-paginacao-ledger/diagnostico-sql.sql) e [diagnostico-sql.json](logs-paginacao-ledger/diagnostico-sql.json).

## Causa raiz comprovada

**Ordenação textual incompatível com a comparação numérica do cursor.** A projeção sequence::text preserva corretamente bigint como string no JSON, mas cria uma coluna de saída de mesmo nome. PostgreSQL resolve ORDER BY sequence como esse alias de saída. EXPLAIN da consulta anterior mostra Sort Key **((sequence)::text)**. Na consulta com limite3, resultado antigo10,11,12; corrigido8,9,10.

Não era instabilidade causada por timestamps iguais: a consulta nem usa created_at como chave de ordenação. Também não era erro do limite, de lookahead ou da codificação do cursor: limit+1 detectava continuidade e o token guardava a última sequência devolvida. O filtro já comparava o bigint correto; era a ordem de seleção da página que não seguia esse filtro. A ordenação textual é determinística, mas incorreta para esse percurso numérico.

SQL anterior (parâmetros $1=wallet, $2=última sequence ou0, $3=limit+1):

~~~sql
SELECT sequence::text,id,transaction_id,direction,amount,currency,
       balance_before,balance_after,created_at
FROM ledger
WHERE wallet_id=$1 AND sequence>$2::bigint
ORDER BY sequence
LIMIT $3;
~~~

SQL corrigido:

~~~sql
SELECT sequence::text,id,transaction_id,direction,amount,currency,
       balance_before,balance_after,created_at
FROM ledger
WHERE wallet_id=$1 AND sequence>$2::bigint
ORDER BY ledger.sequence
LIMIT $3;
~~~

ORDER BY ledger.sequence referencia inequivocamente a coluna bigint original, com ASC implícito. A sequência é chave primária única; portanto desempata de forma determinística mesmo com timestamps idênticos. O índice existente ledger_wallet_sequence(wallet_id,sequence) já corresponde ao filtro/ordem; não foi criada migration ou índice novo.

## Reprodução nova antes da alteração

Primeiro foi adicionado o teste que exige o histórico completo e ele foi executado **antes** da correção em **test_2336f21d3e974f56a6afa28dc5d22bc1**, carteira nova **9ccda8ae-9e67-423d-aa44-bc99121aee71**. Sete aberturas auxiliares fizeram a carteira-alvo começar em sequence 8, sem alterar/resetar sequência ou histórico de qualquer schema anterior. OPENING/BET/REFUND/WIN/ROLLBACK foram produzidos pelo serviço real com as mesmas regras financeiras da auditoria.

Resultado: esperado 7, obtido 5; OPENING8/CREDIT100 e BET9/DEBIT25 ausentes. O teste falhou na comparação integral dos registros SQL com o percurso HTTP. Reconciliação ainda consistente100.00, checkedEntries=7. Registro de cada requisição, status, corpo e duração em [before.jsonl](logs-paginacao-ledger/before.jsonl); teste negativo: [pagination-before-clean.stderr.log](logs-paginacao-ledger/pagination-before-clean.stderr.log), [pagination-before-clean.result.json](logs-paginacao-ledger/pagination-before-clean.result.json). Exit1 é a reprovação esperada do código anterior, não uma aprovação.

A primeira invocação do runner perdeu aspas no argumento da variável de fase no PowerShell. Mesmo assim executou o teste e reproduziu a omissão, mas acrescentou um erro do comando de preparação. Logs preservados em pagination-before.* e before-initial.jsonl. A reprodução foi repetida com a variável definida diretamente no PowerShell e terminou com **somente a falha do teste**, em pagination-before-clean.*. Nenhum erro foi ocultado ou atribuído incorretamente ao produto.

## Alteração e compatibilidade

| Arquivo / linha | Alteração |
| --- | --- |
| [src/application/wagering.ts:595](../../../src/application/wagering.ts#L595) | Somente ORDER BY sequence → ORDER BY ledger.sequence |
| [test/integration/ledger-pagination.test.ts:1](../../../test/integration/ledger-pagination.test.ts#L1) | Novo arquivo com dez regressões HTTP/PostgreSQL, fixture e captura de evidências |
| Este relatório e logs-paginacao-ledger/ | Documentação, logs e verificação de escopo |

O cursor continua sendo o token base64url opaco contendo walletId+sequence; o cliente deve reenviá-lo sem interpretar. Não houve mudança de formato, DTO, endpoint, limites1–100, padrão50, validação de carteira ou tipo sequence:string no JSON. Opaco não significa criptografado/assinado: não se introduziu mecanismo de segurança novo nesta correção.

Para cada página, a API seleciona sequências **estritamente maiores** que o cursor, em ordem numérica crescente, consulta limit+1 e devolve até limit entradas. Havendo continuidade, o próximo token usa a última sequência **devolvida**, não a linha adicional. O sufixo final tem nextCursor=null. Ordenação e filtro agora usam a mesma relação; a chave única impede empate de ordenação. Não é necessária uma segunda chave de timestamp/UUID.

Hashes de **51 arquivos preexistentes** conferidos: somente wagering.ts mudou; a substituição inversa da expressão corrigida reconstrói exatamente o SHA256 anterior desse arquivo. Isso comprova que nem mesmo outras linhas da implementação foram alteradas. Nenhum teste anterior, migration, regra BET/WIN/LOSS/REFUND/ROLLBACK, configuração, package.json ou bun.lock foi modificado. Evidência: [source-before.json](logs-paginacao-ledger/source-before.json), [source-after.json](logs-paginacao-ledger/source-after.json), [verification.json](logs-paginacao-ledger/verification.json).

## Resultados posteriores e ausência de omissões/duplicações

No schema novo **test_a3688b43c6b34d5ca2ba52e2cc19f4ac**, carteira **5a0cc9b1-aed5-4346-bdd3-845b79fd96de**, o mesmo teste percorreu **[8,9], [10,11], [12,13], [14]**: sete registros, sete IDs únicos, nenhuma omissão, mesmo conteúdo/valores que o SELECT SQL ordenado numericamente. ReconciliaçãoHTTP201, saldo100.00/checkedEntries=7. A comparação é integral dos campos, não apenas de quantidade. Evidência: [after.jsonl](logs-paginacao-ledger/after.jsonl).

Outro fixture cria105 WIN/CREDIT0.01 em uma única transação SQL: os defaults now() do PostgreSQL fornecem o **mesmo timestamp** para todos os lançamentos; triggers e constraints financeiras permanecem ativos. É um seed balanceado específico do teste de leitura, sem UPDATE/DELETE de ledger ou alteração de default/migration; não é um teste de produtores/outbox. O cenário de sete movimentos usa os produtores do serviço. O saldo deste fixture é1.05, versão106; toda leitura é comparada ao SQL antes/depois e não muda wallet/ledger. Inclui sequências99 e100.

| Limite | Esperado / obtido | IDs únicos | Páginas | Timestamps distintos | Todos os campos iguais ao SQL |
| --- | --- | --- | --- | --- | --- |
| 1 | 105 / 105 | 105 | 105 | 1 | PASS |
| 2 | 105 / 105 | 105 | 53 | 1 | PASS |
| 3 | 105 / 105 | 105 | 35 | 1 | PASS |
| 7 | 105 / 105 | 105 | 15 | 1 | PASS |
| 50 | 105 / 105 | 105 | 3 | 1 | PASS |
| 100 | 105 / 105 | 105 | 2 | 1 | PASS |

Os seis percursos completos foram aprovados na execução focada e novamente na suíte completa. O JSONL mantém cada resposta e os arrays esperados/obtidos; [verification.json](logs-paginacao-ledger/verification.json) resume limites, contagens, unicidade e comparação integral. Não foram usados mocks de PostgreSQL nem simuladas respostas HTTP.

## Dez testes novos — PASS

| Caso / implementação | Verificação real |
| --- | --- |
| Sequências8–14, linha144 | Endpoint devolve7/7, na ordem SQL, sem IDs duplicados; reconciliação201/100.00 |
| Seis casos parametrizados, linha178 | Limites1/2/3/7/50/100,105 registros com timestamps iguais, fronteira99/100, número correto de páginas e nenhuma mutação |
| Cursor, linha202 | Mesmo token repete a mesma página; mudança de tamanho preserva posição; token alheio/malformado e limites inválidos retornam400 |
| Append entre páginas, linha227 | Inserção válida após a primeira página aparece no restante, sem repetir os anteriores; quatro IDs únicos e reconciliação consistente |
| Wallet vazia, linha247 | HTTP200, entries=[], nextCursor=null |

O contrato opaco é validado pelo round-trip HTTP e repetição do token, sem exigir que consumidores externos o decodifiquem. O teste de igualdade de timestamps comprova que o percurso não depende de desempate por created_at. O conteúdo financeiro anterior permanece idêntico nas seis leituras completas.

## Comandos PowerShell e resultados

| Execução | Início UTC | Duração s | Exit | Observado |
| --- | --- | --- | --- | --- |
| pagination-before | 2026-10-21T20:26:41.930Z | 12.764 | 1 | FAIL anterior + erro de preparação |
| pagination-before-clean | 2026-10-21T20:27:24.015Z | 3.595 | 1 | FAIL anterior reproduzido |
| pagination-focused | 2026-10-21T20:27:38.652Z | 6.435 | 0 | 10 PASS |
| pagination-test-all | 2026-10-21T20:28:06.011Z | 103.608 | 0 | 104 PASS |
| pagination-format | 2026-10-21T20:28:06.037Z | 1.553 | 0 | PASS |
| pagination-typescript | 2026-10-21T20:28:06.604Z | 7.02 | 0 | PASS |

Cada arquivo pagination-*.result.json aponta para stdout/stderr completos; cópias estão nesta pasta de evidências. A suíte completa executou **41 unitários/235 asserções,60 integrações/1440 asserções,3 concorrência/21 asserções**. Os mesmos 94 casos anteriores foram comparados por arquivo+nome e passaram na execução atual; os dez novos também passaram. Ledger/reconciliação foram exercitados pelos dez novos e pelos17 casos de system.test.ts na suíte, incluindo imutabilidade, reversões e atomicidade. Não se somam execuções focadas ao número de casos distintos.

~~~powershell
Set-Location C:\Users\anton\JungleChallenge
# Executado antes da correção, com falha esperada:
$env:PAGINATION_PHASE = 'before'
bun docs/audit/run-command.ts pagination-before-clean 'bun test test/integration/ledger-pagination.test.ts --timeout 60000 -t audit; exit $LASTEXITCODE'
# Depois da alteração de uma expressão:
$env:PAGINATION_PHASE = 'after'
bun docs/audit/run-command.ts pagination-focused 'bun test test/integration/ledger-pagination.test.ts --timeout 60000; exit $LASTEXITCODE'
$env:PAGINATION_PHASE = 'full-suite'
bun docs/audit/run-command.ts pagination-test-all 'bun run test:all; exit $LASTEXITCODE'
$env:PAGINATION_PHASE = $null
bun docs/audit/run-command.ts pagination-format 'bun run format:check; exit $LASTEXITCODE'
bun docs/audit/run-command.ts pagination-typescript 'bunx --no-install tsc --noEmit; exit $LASTEXITCODE'
# Somente leitura no fixture preservado da auditoria anterior:
bun docs/audit/manual/audit-infra.ts sql docs/audit/manual/logs-paginacao-ledger/diagnostico-sql.sql
~~~

Os runners registram o exit real do comando interno no JSON, mesmo quando o processo externo do runner termina normalmente. Formatação foi aplicada somente ao arquivo novo de teste, com prettier local já instalado; não houve instalação/atualização de dependências. TypeScript executado com bunx --no-install. Os testes criam e limpam somente seus próprios schemas/roles/filas; a carteira histórica consultada e os dados compartilhados foram preservados.

## Limitações remanescentes

- Os resultados se referem ao código corrigido e aos processos isolados testados. **As imagens/instâncias compartilhadas não foram atualizadas**; aplicação da correção nelas fica para implantação autorizada posterior. Inventário somente leitura: [shared-containers.jsonl](logs-paginacao-ledger/shared-containers.jsonl).
- Um cursor emitido pelo código anterior depois da sequência11 não recupera retroativamente8/9. O formato continua aceito para o restante maior que11, mas clientes que iniciaram um percurso afetado precisam recomeçar sem cursor para reconstruir todo o histórico. Não se reescreve token ou ledger persistido.
- Requisições de páginas não compartilham um snapshot SQL congelado; novas entradas podem aparecer no decorrer da leitura. Foi testado append normal entre páginas, sem afirmar prova de todas as intercalações possíveis ou um export consistente com cutoff temporal.
- Cursor opaco mantém sua codificação e validações existentes; não é um token criptográfico. Não foi ampliado o escopo para redesenhar paginação, autenticação ou regras financeiras.
- A auditoria anterior permanece um registro histórico de FAIL. Este relatório documenta a reprodução e a validação posterior; não altera seu CSV nem reclassifica resultados antigos como se tivessem passado na época.

Correção isolada concluída e validada. Nenhuma evidência autoriza afirmar correção integral de funcionalidades fora deste defeito.
