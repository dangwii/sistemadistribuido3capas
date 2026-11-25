# Carga las variables del archivo .env local y crea/actualiza los Secrets en Kubernetes
# sin almacenar credenciales dentro del repositorio Git.
param(
    [string]$EnvFile = ".env"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $EnvFile)) {
    Write-Error "No se encontró el archivo $EnvFile. Copia .env.example a .env primero."
    exit 1
}

$vars = @{}
Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
        $parts = $line.Split("=", 2)
        $vars[$parts[0].Trim()] = $parts[1].Trim()
    }
}

$rabbitUser = if ($vars.ContainsKey('RABBITMQ_USER')) { $vars['RABBITMQ_USER'] } else { "miniimdb" }
$rabbitPass = if ($vars.ContainsKey('RABBITMQ_PASSWORD')) { $vars['RABBITMQ_PASSWORD'] } else { $vars['CATALOG_DB_PASSWORD'] }
$rabbitUrl = "amqp://${rabbitUser}:${rabbitPass}@rabbitmq.data.svc.cluster.local:5672"

kubectl create secret generic data-credentials `
    -n data `
    --from-literal="MARIADB_ROOT_PASSWORD=$($vars['MARIADB_ROOT_PASSWORD'])" `
    --from-literal="CATALOG_DB_NAME=$($vars['CATALOG_DB_NAME'])" `
    --from-literal="CATALOG_DB_USER=$($vars['CATALOG_DB_USER'])" `
    --from-literal="CATALOG_DB_PASSWORD=$($vars['CATALOG_DB_PASSWORD'])" `
    --from-literal="MONGO_ROOT_USERNAME=$($vars['MONGO_ROOT_USERNAME'])" `
    --from-literal="MONGO_ROOT_PASSWORD=$($vars['MONGO_ROOT_PASSWORD'])" `
    --from-literal="RABBITMQ_USER=$rabbitUser" `
    --from-literal="RABBITMQ_PASSWORD=$rabbitPass" `
    --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic mini-imdb-secrets `
    -n mini-imdb `
    --from-literal="DB_NAME=$($vars['CATALOG_DB_NAME'])" `
    --from-literal="DB_USER=$($vars['CATALOG_DB_USER'])" `
    --from-literal="DB_PASSWORD=$($vars['CATALOG_DB_PASSWORD'])" `
    --from-literal="MONGO_DB=$($vars['MONGO_DB_NAME'])" `
    --from-literal="MONGO_USER=$($vars['MONGO_ROOT_USERNAME'])" `
    --from-literal="MONGO_PASSWORD=$($vars['MONGO_ROOT_PASSWORD'])" `
    --from-literal="RABBITMQ_URL=$rabbitUrl" `
    --dry-run=client -o yaml | kubectl apply -f -

Write-Output "Secrets sincronizados correctamente en los namespaces 'data' y 'mini-imdb'."
