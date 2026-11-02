# ShadowFocus — Chrome Extension

Cole a URL de um vídeo do YouTube em **inglês ou espanhol** e acompanhe a transcrição em tempo real numa tela preta, com tradução simultânea opcional.

## Instalar (modo desenvolvedor)

1. Abra `chrome://extensions`.
2. Ative **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e selecione esta pasta.
4. Fixe o ícone do ShadowFocus na barra do Chrome.

## Usar

1. Clique no ícone da extensão (se a aba atual for um vídeo do YouTube, a URL já vem preenchida).
2. Escolha a exibição: **só transcrição** ou **transcrição + tradução**.
3. Escolha a visualização:
   - **Tempo real**: as palavras aparecem conforme são ditas.
   - **Blocos**: mostra trechos anteriores, o trecho atual (destacado) e os próximos.
4. Clique em **Abrir**. Na nova aba, use **▶ Play**, **⏸ Pausar** e **⟲ Reiniciar**.

Tradução e visualização também podem ser trocadas durante a reprodução. O idioma do vídeo é detectado automaticamente, e o botão **Tradução** oferece os outros dois idiomas:

| Vídeo em | Opções de tradução |
| -------- | ------------------ |
| Inglês   | Português (BR), Espanhol |
| Espanhol | Português (BR), Inglês   |

### Atalhos

| Tecla       | Ação                    |
| ----------- | ----------------------- |
| Espaço / K  | Play / pausar           |
| R           | Reiniciar               |
| ← / →       | Voltar / avançar 5 s    |
| ↑ / ↓       | Aumentar / diminuir volume |
| T           | Liga/desliga tradução (último idioma escolhido) |
| M           | Tempo real / blocos     |
| + / −       | Tamanho do texto        |
| V           | Mostrar/minimizar o vídeo |
| F           | Tela cheia              |
| < / >       | Diminuir / aumentar velocidade |

## Como funciona

- **Áudio**: o vídeo roda num player do YouTube embutido (no canto da tela, minimizável), controlado por `postMessage` (`lib/embed.js`). O tempo do player é interpolado a cada quadro para sincronizar o texto.
- **Transcrição**: as legendas do próprio YouTube (`lib/youtube.js`). O idioma do vídeo vem da faixa de legenda automática (que está sempre no idioma falado); nesse idioma, prefere a legenda manual. Vídeos que não são em inglês nem espanhol usam a tradução automática do YouTube para inglês. As legendas viram palavras com tempo e são agrupadas em frases (`lib/transcript.js`).
- **Tradução**: Google Tradutor em lotes (`lib/translate.js`), guardada por idioma para trocar sem traduzir de novo; se falhar, usa a tradução automática do YouTube.
- **Plano B**: se o vídeo não tiver legendas acessíveis, é possível carregar um arquivo `.srt` ou `.vtt`.

## Limitações

- Depende de endpoints não oficiais do YouTube e do Google Tradutor, que podem mudar sem aviso.
- Vídeos cujo dono bloqueia reprodução fora do YouTube não tocam.
- O YouTube exige um cabeçalho `Referer` em players embutidos; a extensão define esse cabeçalho só na aba do player, via regra de sessão do `declarativeNetRequest`.
