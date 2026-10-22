param([string]$StatePath = 'docs/audit/homologation/run-state.json')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
$apiBases = @($state.hostPorts.apis | ForEach-Object { 'http://' + $_ })
$requests = [System.Collections.Generic.List[object]]::new()
$client = [System.Net.Http.HttpClient]::new()
[System.Net.ServicePointManager]::DefaultConnectionLimit = 100

function Send-Http {
  param([string]$Method, [string]$Uri, [string]$Body, [string]$IdempotencyKey)
  $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $Uri)
  if (-not [string]::IsNullOrEmpty($Body)) { $request.Content = [System.Net.Http.StringContent]::new($Body, [Text.Encoding]::UTF8, 'application/json') }
  if ($IdempotencyKey) { [void]$request.Headers.Add('Idempotency-Key', $IdempotencyKey) }
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $response = $client.SendAsync($request).GetAwaiter().GetResult()
  $watch.Stop()
  $raw = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  try { $parsed = $raw | ConvertFrom-Json } catch { $parsed = $raw }
  $requests.Add([pscustomobject]@{ method=$Method; uri=$Uri; requestBody=$Body; idempotencyKey=$IdempotencyKey; status=[int]$response.StatusCode; responseBody=$parsed; durationMs=$watch.Elapsed.TotalMilliseconds })
  $result = [pscustomobject]@{ status=[int]$response.StatusCode; body=$parsed }
  $request.Dispose(); $response.Dispose()
  return $result
}

function Require($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function New-Body([string]$Provider,[string]$External,[string]$Wallet,[string]$Player,[string]$Kind,[string]$Amount,[string]$Reference,[string]$Round) {
  $body = [ordered]@{ providerId=$Provider; externalTransactionId=$External; playerId=$Player; walletId=$Wallet; roundId=$Round; gameId='homologation-game'; kind=$Kind; money=@{ amount=$Amount; currency='BRL' } }
  if ($Reference) { $body.referenceExternalTransactionId=$Reference }
  return $body
}
function Post-Wager([int]$ApiIndex,$Body,[string]$Key) {
  return Send-Http 'POST' ($apiBases[$ApiIndex] + '/wagering/transactions') (ConvertTo-Json -InputObject $Body -Depth 8 -Compress) $Key
}
function New-Token($Object) {
  $json = ConvertTo-Json -InputObject $Object -Depth 8 -Compress
  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)).TrimEnd('=').Replace('+','-').Replace('/','_')
}

$health = @()
for ($i=0; $i -lt $apiBases.Count; $i++) {
  foreach ($path in @('/health/live','/health/ready','/metrics')) {
    $r = Send-Http 'GET' ($apiBases[$i]+$path) $null $null
    Require ($r.status -eq 200) "API $i $path returned $($r.status)"
    $health += [pscustomobject]@{api=$i;path=$path;status=$r.status;body=$r.body}
  }
}

# Exercise all five financial kinds through independently addressed API instances.
$player = [guid]::NewGuid().ToString()
$open = Send-Http 'POST' ($apiBases[0]+'/wallets') (@{playerId=$player;initialBalance=@{amount='100.00';currency='BRL'}}|ConvertTo-Json -Depth 5 -Compress) $null
Require ($open.status -eq 201) 'Wallet opening did not return HTTP 201'
$wallet = $open.body
$bet = New-Body 'homologation-provider' ([guid]::NewGuid().ToString()) $wallet.id $player 'BET' '25.00' $null 'homologation-round'
$betResult = Post-Wager 0 $bet ('homologation-bet-'+[guid]::NewGuid().ToString())
Require ($betResult.status -eq 200 -and $betResult.body.status -eq 'PROCESSED') 'BET did not process'
$win = New-Body 'homologation-provider' ([guid]::NewGuid().ToString()) $wallet.id $player 'WIN' '10.00' $bet.externalTransactionId 'homologation-round'
$winResult = Post-Wager 1 $win ('homologation-win-'+[guid]::NewGuid().ToString())
Require ($winResult.status -eq 200 -and $winResult.body.status -eq 'PROCESSED') 'WIN did not process'
$loss = New-Body 'homologation-provider' ([guid]::NewGuid().ToString()) $wallet.id $player 'LOSS' '1.00' $null 'homologation-round'
$lossResult = Post-Wager 2 $loss ('homologation-loss-'+[guid]::NewGuid().ToString())
Require ($lossResult.status -eq 200 -and $lossResult.body.status -eq 'PROCESSED') 'LOSS did not process'
$refund = New-Body 'homologation-provider' ([guid]::NewGuid().ToString()) $wallet.id $player 'REFUND' '25.00' $bet.externalTransactionId 'homologation-round'
$refundResult = Post-Wager 0 $refund ('homologation-refund-'+[guid]::NewGuid().ToString())
Require ($refundResult.status -eq 200 -and $refundResult.body.status -eq 'PROCESSED') 'REFUND did not process'
$rollback = New-Body 'homologation-provider' ([guid]::NewGuid().ToString()) $wallet.id $player 'ROLLBACK' '10.00' $win.externalTransactionId 'homologation-round'
$rollbackResult = Post-Wager 1 $rollback ('homologation-rollback-'+[guid]::NewGuid().ToString())
Require ($rollbackResult.status -eq 200 -and $rollbackResult.body.status -eq 'PROCESSED') 'ROLLBACK did not process'
$walletAfter = Send-Http 'GET' ($apiBases[2]+'/wallets/'+$wallet.id) $null $null
$reconciliation = Send-Http 'POST' ($apiBases[2]+'/wallets/'+$wallet.id+'/reconciliation') $null $null
Require ($walletAfter.body.balance.amount -eq '100.00' -and $walletAfter.body.version -eq 5) 'Financial flow balance/version mismatch'
Require ($reconciliation.status -eq 201 -and $reconciliation.body.consistent -and $reconciliation.body.checkedEntries -eq 5) 'Financial flow reconciliation mismatch'
$ledger = @(); $cursor = $null; $pages = 0
do {
  $path = '/wallets/'+$wallet.id+'/ledger?limit=2'
  if ($cursor) { $path += '&cursor='+[Uri]::EscapeDataString($cursor) }
  $page = Send-Http 'GET' ($apiBases[($pages % 3)]+$path) $null $null
  Require ($page.status -eq 200) 'Ledger page did not return HTTP 200'
  $ledger += @($page.body.entries); $cursor=$page.body.nextCursor; $pages++
  if ($pages -gt 10) { throw 'LEDGER_PAGINATION_DID_NOT_TERMINATE' }
} while ($cursor)
Require ($ledger.Count -eq 5 -and @($ledger.id|Select-Object -Unique).Count -eq 5) 'Ledger pagination omitted or duplicated rows'
$legacyToken = New-Token ([ordered]@{walletId=$wallet.id;sequence='1'})
$legacyResult = Send-Http 'GET' ($apiBases[0]+'/wallets/'+$wallet.id+'/ledger?cursor='+[Uri]::EscapeDataString($legacyToken)) $null $null
Require ($legacyResult.status -eq 200) 'Legacy opaque cursor was not accepted'
$invalidObjects = @(
  [ordered]@{walletId=$wallet.id;sequence=@('8')},
  [ordered]@{walletId=$wallet.id;sequence='-1'},
  [ordered]@{walletId=$wallet.id;sequence='9223372036854775808'},
  [ordered]@{walletId=$wallet.id;sequence=8},
  [ordered]@{walletId=([guid]::NewGuid().ToString());sequence='8'}
)
$invalidCursorResults = @()
foreach ($obj in $invalidObjects) {
  $token = New-Token $obj
  $r = Send-Http 'GET' ($apiBases[0]+'/wallets/'+$wallet.id+'/ledger?cursor='+[Uri]::EscapeDataString($token)) $null $null
  Require ($r.status -eq 400 -and $r.body.code -eq 'INVALID_CURSOR') "Invalid cursor returned $($r.status) $($r.body.code)"
  $invalidCursorResults += $r
}
$bad = Send-Http 'GET' ($apiBases[0]+'/wallets/'+$wallet.id+'/ledger?cursor=%%%') $null $null
Require ($bad.status -eq 400 -and $bad.body.code -eq 'INVALID_CURSOR') 'Malformed cursor was not HTTP 400'
$repeat = Send-Http 'GET' ($apiBases[0]+'/wallets/'+$wallet.id+'/ledger?cursor='+[Uri]::EscapeDataString($legacyToken)+'&cursor='+[Uri]::EscapeDataString($legacyToken)) $null $null
Require ($repeat.status -eq 400 -and $repeat.body.code -eq 'INVALID_CURSOR') 'Repeated cursor parameter was not rejected'

# Thirty identical requests are distributed across the three running API containers.
$dupePlayer = [guid]::NewGuid().ToString()
$dupeWallet = (Send-Http 'POST' ($apiBases[1]+'/wallets') (@{playerId=$dupePlayer;initialBalance=@{amount='100.00';currency='BRL'}}|ConvertTo-Json -Depth 5 -Compress) $null).body
$dupeBody = New-Body 'homologation-provider' ([guid]::NewGuid().ToString()) $dupeWallet.id $dupePlayer 'BET' '25.00' $null 'dupe-round'
$dupeJson = ConvertTo-Json -InputObject $dupeBody -Depth 8 -Compress
$dupeKey = 'homologation-distributed-'+[guid]::NewGuid().ToString()
$pending = @()
for ($i=0; $i -lt 30; $i++) {
  $api = $i % 3
  $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, $apiBases[$api]+'/wagering/transactions')
  $request.Content = [System.Net.Http.StringContent]::new($dupeJson,[Text.Encoding]::UTF8,'application/json')
  [void]$request.Headers.Add('Idempotency-Key',$dupeKey)
  $pending += [pscustomobject]@{task=$client.SendAsync($request);request=$request;api=$api;started=[DateTime]::UtcNow}
}
[System.Threading.Tasks.Task]::WhenAll([System.Threading.Tasks.Task[]]@($pending|ForEach-Object {$_.task})).GetAwaiter().GetResult()
$dupeResponses = @()
foreach ($p in $pending) {
  $response=$p.task.Result; $raw=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult(); $body=$raw|ConvertFrom-Json
  $requests.Add([pscustomobject]@{method='POST';uri=($apiBases[$p.api]+'/wagering/transactions');requestBody=$dupeJson;idempotencyKey=$dupeKey;status=[int]$response.StatusCode;responseBody=$body;durationMs=([DateTime]::UtcNow-$p.started).TotalMilliseconds})
  $dupeResponses += [pscustomobject]@{status=[int]$response.StatusCode;body=$body;api=$p.api}
  $response.Dispose();$p.request.Dispose()
}
$ids=@($dupeResponses.body.transactionId|Select-Object -Unique)
$replays=@($dupeResponses|Where-Object {$_.body.idempotentReplay}).Count
Require ($dupeResponses.Count -eq 30 -and @($dupeResponses|Where-Object status -ne 200).Count -eq 0) 'Duplicate fanout had non-200 response'
Require ($ids.Count -eq 1 -and $replays -eq 29) 'Thirty-way idempotency result mismatch'
$dupeWalletAfter=Send-Http 'GET' ($apiBases[0]+'/wallets/'+$dupeWallet.id) $null $null
$dupeLedger=Send-Http 'GET' ($apiBases[1]+'/wallets/'+$dupeWallet.id+'/ledger?limit=100') $null $null
$dupeRecon=Send-Http 'POST' ($apiBases[2]+'/wallets/'+$dupeWallet.id+'/reconciliation') $null $null
Require ($dupeWalletAfter.body.balance.amount -eq '75.00' -and $dupeWalletAfter.body.version -eq 2) 'Thirty-way duplicate changed balance/version incorrectly'
Require (@($dupeLedger.body.entries|Where-Object direction -eq 'DEBIT').Count -eq 1 -and $dupeLedger.body.entries.Count -eq 2) 'Thirty-way duplicate ledger mismatch'
Require ($dupeRecon.body.consistent) 'Thirty-way duplicate reconciliation failed'

# Two distinct 80 BRL bets compete across API instances.
$racePlayer=[guid]::NewGuid().ToString()
$raceWallet=(Send-Http 'POST' ($apiBases[0]+'/wallets') (@{playerId=$racePlayer;initialBalance=@{amount='100.00';currency='BRL'}}|ConvertTo-Json -Depth 5 -Compress) $null).body
$raceBodies=@(
  (New-Body 'homologation-provider' ([guid]::NewGuid().ToString()) $raceWallet.id $racePlayer 'BET' '80.00' $null 'race-round'),
  (New-Body 'homologation-provider' ([guid]::NewGuid().ToString()) $raceWallet.id $racePlayer 'BET' '80.00' $null 'race-round')
)
$race1=Post-Wager 1 $raceBodies[0] ('homologation-race-a-'+[guid]::NewGuid().ToString())
$race2=Post-Wager 2 $raceBodies[1] ('homologation-race-b-'+[guid]::NewGuid().ToString())
Require (@(@($race1,$race2)|Where-Object {$_.body.status -eq 'PROCESSED'}).Count -eq 1 -and @(@($race1,$race2)|Where-Object {$_.body.status -eq 'REJECTED'}).Count -eq 1) '80 BRL competition statuses mismatch'
$raceWalletAfter=Send-Http 'GET' ($apiBases[0]+'/wallets/'+$raceWallet.id) $null $null
$raceLedger=Send-Http 'GET' ($apiBases[1]+'/wallets/'+$raceWallet.id+'/ledger?limit=100') $null $null
$raceRecon=Send-Http 'POST' ($apiBases[2]+'/wallets/'+$raceWallet.id+'/reconciliation') $null $null
Require ($raceWalletAfter.body.balance.amount -eq '20.00' -and $raceWalletAfter.body.version -eq 2) '80 BRL competition balance/version mismatch'
Require (@($raceLedger.body.entries|Where-Object direction -eq 'DEBIT').Count -eq 1) '80 BRL competition duplicated debit'
Require ($raceRecon.body.consistent) '80 BRL competition reconciliation failed'

$summary=[ordered]@{
  generatedAt=[DateTime]::UtcNow.ToString('o'); project=$state.project; apiBases=$apiBases
  health=$health
  financialFlow=[ordered]@{walletId=$wallet.id;initial='100.00';final=$walletAfter.body.balance.amount;version=$walletAfter.body.version;operations=@(@{kind='BET';status=$betResult.status;result=$betResult.body},@{kind='WIN';status=$winResult.status;result=$winResult.body},@{kind='LOSS';status=$lossResult.status;result=$lossResult.body},@{kind='REFUND';status=$refundResult.status;result=$refundResult.body},@{kind='ROLLBACK';status=$rollbackResult.status;result=$rollbackResult.body});ledger=$ledger;reconciliation=$reconciliation.body;pages=$pages}
  cursorValidation=[ordered]@{legacyTokenStatus=$legacyResult.status;invalidStatuses=@($invalidCursorResults|ForEach-Object {$_.status});malformedStatus=$bad.status;repeatedParameterStatus=$repeat.status}
  distributedIdempotency=[ordered]@{walletId=$dupeWallet.id;requests=30;apisUsed=@($dupeResponses.api|Select-Object -Unique).Count;distinctTransactionIds=$ids.Count;replays=$replays;statusCounts=($dupeResponses|Group-Object status|ForEach-Object {"$($_.Name):$($_.Count)"});balance=$dupeWalletAfter.body.balance.amount;version=$dupeWalletAfter.body.version;ledger=$dupeLedger.body.entries;reconciliation=$dupeRecon.body}
  balanceCompetition=[ordered]@{walletId=$raceWallet.id;responses=@($race1,$race2);balance=$raceWalletAfter.body.balance.amount;version=$raceWalletAfter.body.version;ledger=$raceLedger.body.entries;reconciliation=$raceRecon.body}
  requestCount=$requests.Count
}
$summary | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath 'docs/audit/homologation/logs/http-smoke-summary.json' -Encoding UTF8
$requests | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath 'docs/audit/homologation/logs/http-smoke-requests.json' -Encoding UTF8
$summary | ConvertTo-Json -Depth 10
$client.Dispose()
