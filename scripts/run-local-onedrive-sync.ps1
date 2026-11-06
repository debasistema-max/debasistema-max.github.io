param(
  [string]$WorkbookPath = (Join-Path $env:OneDrive 'calculos-impostos-PR-SP-SC-otimizado.xlsx'),
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$projectRef = 'cwwrqvitclsvpqbzfhti'
$projectUrl = "https://$projectRef.supabase.co"

if (-not (Test-Path -LiteralPath $WorkbookPath -PathType Leaf)) {
  throw "Planilha autorizada nao encontrada: $WorkbookPath"
}

$resolvedWorkbook = (Resolve-Path -LiteralPath $WorkbookPath).Path
$resolvedOneDrive = (Resolve-Path -LiteralPath $env:OneDrive).Path.TrimEnd('\') + '\'
if (-not $resolvedWorkbook.StartsWith($resolvedOneDrive, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'A planilha precisa estar dentro da pasta sincronizada do OneDrive.'
}

if ($ValidateOnly) {
  & (Join-Path $env:ProgramFiles 'nodejs\npm.cmd') run validate:catalog -- $resolvedWorkbook
  exit $LASTEXITCODE
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DebaPortalCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist;
    public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 reservedFlag, out IntPtr credentialPtr);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern void CredFree(IntPtr cred);
}
'@

$credentialPointer = [IntPtr]::Zero
if (-not [DebaPortalCredential]::CredRead('Supabase CLI:supabase', 1, 0, [ref]$credentialPointer)) {
  throw 'Entre no Supabase CLI antes de executar a sincronizacao.'
}

try {
  $credential = [Runtime.InteropServices.Marshal]::PtrToStructure(
    $credentialPointer,
    [type][DebaPortalCredential+CREDENTIAL]
  )
  $secretBytes = New-Object byte[] $credential.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy(
    $credential.CredentialBlob,
    $secretBytes,
    0,
    $credential.CredentialBlobSize
  )
  $managementToken = [Text.Encoding]::UTF8.GetString($secretBytes).Trim([char]0)
  [Array]::Clear($secretBytes, 0, $secretBytes.Length)
} finally {
  [DebaPortalCredential]::CredFree($credentialPointer)
}

try {
  $keys = Invoke-RestMethod -Method Get `
    -Uri "https://api.supabase.com/v1/projects/$projectRef/api-keys" `
    -Headers @{ Authorization = "Bearer $managementToken" }
  $serviceRoleKey = ($keys | Where-Object { $_.name -eq 'service_role' } | Select-Object -First 1).api_key
  if (-not $serviceRoleKey) { throw 'Chave segura do executor nao encontrada.' }

  $env:SUPABASE_URL = $projectUrl
  $env:SUPABASE_SERVICE_ROLE_KEY = $serviceRoleKey
  & (Join-Path $env:ProgramFiles 'nodejs\npm.cmd') run sync:catalog -- --import $resolvedWorkbook
  if ($LASTEXITCODE -ne 0) { throw "A sincronizacao terminou com codigo $LASTEXITCODE." }
} finally {
  Remove-Item Env:SUPABASE_URL, Env:SUPABASE_SERVICE_ROLE_KEY -ErrorAction SilentlyContinue
  $managementToken = $null
  $serviceRoleKey = $null
}
