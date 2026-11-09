import { createServer } from "node:http";

// A hostile stylesheet and no permitted iframe: exercises the shipped artifact
// on a non-React host, not the source modules or the demo's React tree.
createServer((_request, response) => {
	response.setHeader("Content-Type", "text/html; charset=utf-8");
	response.setHeader(
		"Content-Security-Policy",
		"default-src 'none'; script-src http://127.0.0.1:4310; style-src 'unsafe-inline' http://127.0.0.1:4310; connect-src http://127.0.0.1:4310; frame-src 'none'",
	);
	response.end(
		`<!doctype html><html lang="fr"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hôte HTML de test</title><style>button{background:red!important;color:red!important}p{margin:100px!important}</style><script type="module" src="http://127.0.0.1:4310/widget.js"></script></head><body><button id="host">Bouton hôte</button><albert-chat></albert-chat></body></html>`,
	);
}).listen(4311, "127.0.0.1");
