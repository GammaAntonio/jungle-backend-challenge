# Diagnóstico de persistência LocalStack/SQS

**Data:** 21/10/2026
**Projeto isolado:** `jungle-homologation-91cf8f`
**Resultado:** **FAIL reprodutível / correção BLOCKED por requisito de licença ausente**. Não foi alterado código nem configuração nesta investigação.

## Conclusão

A perda de filas não foi causada por workers consumidores, por um volume ausente, por permissões do diretório ou pelo initializer. Ela se reproduziu com filas FIFO exclusivas e todos os workers parados, tanto em reinício normal do container quanto em recriação do container preservando o mesmo volume. A cada cenário, a fila existia e tinha uma mensagem antes; após o ciclo, `ListQueues` não retornou fila e `GetQueueAttributes` respondeu `AWS.SimpleQueueService.NonExistentQueue`.

A causa é a edição efetiva do emulador: a imagem `localstack/localstack:4.6` respondeu `edition=community`, `version=4.6.0`. Embora o container receba `PERSISTENCE=1`, as estratégias de snapshot e o volume persistente, esta edição não implementou a persistência por snapshots esperada: o diretório `state` ficou vazio, e `POST /_localstack/state/sqs/save` retornou HTTP 404. A documentação oficial apresenta a persistência como recurso dos planos Base/Ultimate e seu exemplo Docker usa `localstack/localstack-pro` com `LOCALSTACK_AUTH_TOKEN` obrigatório. Não existe esse token na configuração do projeto nem no ambiente desta execução; portanto, não é possível habilitar a opção Pro com segurança ou comprovar a correção sem credencial/licença apropriada. O volume e as variáveis configuradas não corrigem a limitação da edição Community.

Referências oficiais: [persistência e estratégias de snapshots](https://docs.localstack.cloud/aws/developer-tools/snapshots/persistence/) e [opções de configuração](https://docs.localstack.cloud/aws/customization/configuration-options/). A documentação informa que `ON_REQUEST` salva estado após chamadas mutáveis, `ON_SHUTDOWN` salva durante encerramento normal, e que a persistência requer `PERSISTENCE=1`; a configuração atual usou `ON_REQUEST` e `ON_STARTUP`. O endpoint manual documentado também não existe no runtime testado.

## Configuração efetiva e volume

- Imagem: `localstack/localstack:4.6`; image ID `sha256:5a97e0f9917a3f0d9630bb13b9d8ccf10cbe52f33252807d3b4e21418cc21348`.
- Health interno: HTTP 200; `edition=community`, `version=4.6.0`, SQS `running`.
- `PERSISTENCE=1`, `SNAPSHOT_SAVE_STRATEGY=ON_REQUEST`, `SNAPSHOT_LOAD_STRATEGY=ON_STARTUP`, `SERVICES=sqs` foram confirmados com `printenv` no container.
- Volume `jungle-homologation-91cf8f-localstack-data` montado em `/var/lib/localstack`, `RW=true`. O ponto raiz reportou `root:root 777`; `state` reportou `root:root 755`; o processo é `root`. O diretório `/var/lib/localstack/state` estava vazio antes e depois dos dois ciclos.
- Nenhum `LOCALSTACK_AUTH_TOKEN` está definido na configuração Compose ou disponível no ambiente PowerShell desta auditoria.
- O mapeamento dinâmico mudou após os ciclos. No fim desta execução o endpoint local publicado foi `127.0.0.1:54290`; consulte `run-state.json` e `docker compose ps --format json` para o mapeamento atual.

Evidência de configuração: `logs/localstack-effective-persistence-config.json`. A montagem completa foi observada por `docker inspect` e as permissões por `stat` dentro do container.

## Reprodução sem consumidores

Os três containers `worker` foram parados somente no Compose isolado (`docker compose ... stop worker`). `docker compose ps` mostrou zero containers worker; a API não consome filas. Não houve chamadas ao initializer durante cada janela de observação.

### Reinício do container

Antes do restart foi criada `jh-91cf8f-probe-manual.fifo`, enviada uma mensagem de corpo inerte `probe-persist-no-consumer-20261021`, com MessageId `99942f8d-51e0-48aa-b9c5-623fce37f5e0` e SequenceNumber `15398510392514707457`. `GetQueueAttributes` respondeu `ApproximateNumberOfMessages=1`. O comando executado foi `docker compose --env-file <env isolado> -p jungle-homologation-91cf8f -f docs/audit/homologation/compose.yaml restart localstack`.

Depois do restart, o health do LocalStack respondeu HTTP 200, mas `awslocal sqs list-queues` produziu saída vazia; a consulta de atributos da mesma fila respondeu `AWS.SimpleQueueService.NonExistentQueue`. O `state` continuou vazio. A perda de visibilidade da fila não decorreu de consumo: não havia workers ativos e a mensagem jamais foi recebida por consumidor.

### Recriação do container

Para comparar o ciclo de vida, foi criada uma segunda fila exclusiva, `jh-91cf8f-probe-recreate.fifo`, com corpo `probe-persist-no-consumer-recreate-20261021`, MessageId `446715af-7ab9-4c86-96f7-573416701e17` e contagem visível `1`. Executou-se `docker compose ... up -d --force-recreate localstack`, sem `down`, sem remover o volume e com workers parados. Após a recriação, o health respondeu HTTP 200, `ListQueues` permaneceu vazio e `GetQueueAttributes` respondeu `AWS.SimpleQueueService.NonExistentQueue`. O volume nomeado continuou montado e o diretório `state` vazio.

As evidências estruturadas e os resultados de cada ciclo estão em `logs/localstack-no-consumer-before-restart.json`, `logs/localstack-no-consumer-after-restart.json` e `logs/localstack-no-consumer-after-recreate.json`. A sondagem anterior de `POST /_localstack/state/sqs/save` registrou HTTP 404 em `logs/localstack-explicit-snapshot-probe.json`.

## Outras causas verificadas

- **Consumo por workers:** descartado para a reprodução; os workers isolados estavam parados e as filas de prova não eram usadas pelo tráfego HTTP.
- **Volume/permissões:** descartado como causa demonstrada; o volume certo estava montado em modo leitura/escrita, o processo era root, e ambos os diretórios permitiam acesso. O volume não continha snapshot porque a funcionalidade não estava disponível na edição observada.
- **Initializer:** `scripts/init-sqs.ts` chama `initQueues()`. `src/infrastructure/sqs.ts:40-69` usa `CreateQueueCommand` e ajusta `RedrivePolicy` com `SetQueueAttributesCommand`; não usa `DeleteQueueCommand` ou `PurgeQueueCommand`. Portanto, não apaga mensagens existentes. A execução histórica registrada em `logs/reinit-after-localstack-restart.log` recriou as três filas de aplicação depois que o restart já as tinha removido do estado do broker; elas ficaram vazias. O initializer pode criar novamente recursos ausentes, mas não explica a perda ocorrida antes de ser chamado.
- **Restart versus recreate:** ambos perderam a fila e mensagem e ambos mantiveram o mesmo volume. Não foi observada diferença de durabilidade entre os dois modos.

## Impacto para o README e homologação

O README exige tolerância à indisponibilidade temporária de SQS, recuperação após reinicialização e declara como invariante não perder eventos confirmados (linhas 57-61 e 696-699). A configuração atual não consegue demonstrar essa recuperação: o processo aceita publicação no SQS efêmero, e um evento já marcado como publicado na outbox pode deixar de estar na fila após reinício do emulador. A execução anterior da homologação já observou filas de eventos vazias após restart, enquanto o banco preservou o estado `published` da outbox.

Isso prova um **bloqueio da homologação com esta configuração**, não que o serviço AWS SQS tenha a mesma semântica, e não demonstra corrupção de saldo. A Etapa 8 não deve ser declarada concluída enquanto a execução da fila sobreviver a reinício/recriação ou houver um mecanismo de recuperação demonstrado para eventos confirmados.

## Correção e status

Não foi aplicada uma alteração. A correção de configuração necessária para usar a persistência nativa seria executar uma edição/plano de LocalStack que ofereça snapshots, com a versão compatível e a autenticação licenciada requerida, mantendo o volume montado e repetindo os dois testes com consulta da fila e do corpo da mensagem antes/depois. A documentação oficial apresenta a imagem Pro e exige `LOCALSTACK_AUTH_TOKEN`; esse token não está disponível. Trocar agora para uma imagem licenciada sem token deixaria o ambiente incapaz de iniciar; trocar por uma imagem de terceiros não foi considerado uma correção segura sem avaliação independente de suporte e compatibilidade.

Classificação: **FAIL** para persistência SQS da configuração atual; **BLOCKED** para correção/verificação da edição licenciada, por falta de credencial/licença acessível. A falha de persistência permanece um bloqueador **HIGH** para preparação da entrega/homologação. Não foi executada nova suíte `bun run test:all`, `format:check` ou TypeScript, pois nenhuma configuração/código do produto foi alterada. A evidência histórica de 108 testes aprovados continua sendo apenas o resultado anterior e não altera este diagnóstico.

## Comandos PowerShell reproduzíveis

Os comandos abaixo devem ser executados apenas contra o projeto de homologação, usando o arquivo temporário isolado e sem `down` ou remoção de volumes. Para repetir com novos nomes de fila, mantenha o prefixo exclusivo `jh-91cf8f-` ou gere outro prefixo de auditoria. Pare primeiro os workers isolados para eliminar consumidores.

```powershell
$s = Get-Content docs/audit/homologation/run-state.json -Raw | ConvertFrom-Json
$compose = 'docs/audit/homologation/compose.yaml'
docker compose --env-file $s.envFile -p $s.project -f $compose stop worker
docker exec "$($s.project)-localstack-1" awslocal sqs create-queue --queue-name jh-91cf8f-probe-new.fifo --attributes FifoQueue=true,ContentBasedDeduplication=false
docker exec "$($s.project)-localstack-1" awslocal sqs send-message --queue-url http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/jh-91cf8f-probe-new.fifo --message-body inert-persistence-probe --message-group-id audit --message-deduplication-id audit-probe-new
docker exec "$($s.project)-localstack-1" awslocal sqs get-queue-attributes --queue-url http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/jh-91cf8f-probe-new.fifo --attribute-names ApproximateNumberOfMessages
docker compose --env-file $s.envFile -p $s.project -f $compose restart localstack
docker compose --env-file $s.envFile -p $s.project -f $compose ps --format json
docker exec "$($s.project)-localstack-1" awslocal sqs list-queues
docker exec "$($s.project)-localstack-1" awslocal sqs get-queue-attributes --queue-url http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/jh-91cf8f-probe-new.fifo --attribute-names ApproximateNumberOfMessages
docker exec "$($s.project)-localstack-1" sh -c 'ls -la /var/lib/localstack/state'
```
