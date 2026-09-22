# Projeto 3.0 v2.49

## ADM
Login padrão: `kxx1`
Senha padrão: `adm123`

Não é necessário rodar `RESET-ADM.bat` a cada início.

## Iniciar

```powershell
npm.cmd install
npm.cmd start
```

Se a pasta extraída tiver outra pasta dentro dela, use:

```powershell
$pkg=Get-ChildItem "$HOME\Desktop\kx-ice-crash-v2.49" -Filter package.json -Recurse -File | Select-Object -First 1; if($pkg){Set-Location $pkg.DirectoryName; npm.cmd install}else{Write-Host "package.json não encontrado"}
```

Depois:

```powershell
npm.cmd start
```

## WhatsApp

- Pareamento por número de telefone.
- Código personalizado exibido como `KXXX VAPO`.
- Números ativos mostram somente conexões reais.

## Envio

- O administrador define a mensagem e o intervalo em segundos.
- O painel inicia um novo trabalho conforme o intervalo definido.
- Cada trabalho aparece com o número e botão `✕` enquanto estiver pendente/enviando.
- Cancelamento impede o envio se ele ainda não entrou no `sendMessage` do WhatsApp.
- Depois que o WhatsApp já aceitou/transmitiu uma mensagem, o botão não consegue desfazê-la.
- Não existe retry automático.
- O socket do WhatsApp mantém uma fila interna por conexão para evitar chamadas `sendMessage` concorrentes, que podem causar perda ou duplicação.
- Limite do plano: 5.000 envios.


## Projeto 3.0
Interface atualizada somente na área **Envio** do usuário com o botão **COMANDOS** e seleção visual de **Crash Android** / **Crash iOS**. A seleção é apenas visual e não executa payload de travamento.

### Instalação
```powershell
npm.cmd install
npm.cmd start
```
