import { EXTERNAL_PAIRING_TTL_MS } from '../../domain/external-agent.js';

export type InviteLocale = 'en' | 'es';

export function inviteLocaleOf(value: unknown): InviteLocale {
  return typeof value === 'string' && value.toLowerCase().startsWith('es') ? 'es' : 'en';
}

/** The command the pasted text runs; `@latest`, so a machine never pairs with a retired daemon. */
function connectCommand(code: string): string {
  return `npx -y @alia-codea/cli@latest connect ${code} --cli <claude|codex|opencode>`;
}

/**
 * The text a person pastes into Claude Code, Codex or OpenCode (ADR 0030, ADR 0038).
 *
 * Self-sufficient: it carries a single-use code and one command, and nothing else is needed — no
 * sign-in, no account, no configuration. The code is the authorisation; redeeming it leaves the
 * machine a credential for this one agent. It is written to be read by a model, so it says what to
 * run, how to keep it running, what to report and when to stop.
 */
export function buildInvitePrompt(input: { code: string; locale: InviteLocale }): string {
  const minutes = Math.round(EXTERNAL_PAIRING_TTL_MS / 60_000);
  const command = connectCommand(input.code);
  if (input.locale === 'es') {
    return [
      'Quiero conectarte a Gemies (https://gemies.ai) como uno de mis gemies, para hablar contigo desde allí y que mis otros gemies te escriban.',
      '',
      'Ejecuta este comando en este equipo, desde la carpeta en la que quiero que trabajes (podrás editar archivos ahí). No termina: lánzalo en segundo plano y déjalo corriendo.',
      '',
      `  ${command}`,
      '',
      'Sustituye <claude|codex|opencode> por el que seas tú. No pide iniciar sesión en ningún sitio: el código es la autorización.',
      'Cuando muestre "Connected", dímelo y no hagas nada más: desde ahí el proceso atiende los mensajes de Gemies usando esta misma herramienta, con mi cuenta.',
      'Si se detiene, `npx -y @alia-codea/cli@latest connect` (sin código) lo vuelve a conectar.',
      `El código es de un solo uso y caduca en ${minutes} minutos. Si tu sandbox no deja salir a la red, pídeme permiso para ejecutarlo con red. No instales nada más ni cambies ninguna configuración.`,
    ].join('\n');
  }
  return [
    "I'm connecting you to Gemies (https://gemies.ai) as one of my gemies, so I can talk to you from there and my other gemies can message you.",
    '',
    'Run this command on this machine, from the folder I want you to work in (you will be able to edit files there). It does not exit: start it in the background and leave it running.',
    '',
    `  ${command}`,
    '',
    'Replace <claude|codex|opencode> with whichever one you are. It asks for no sign-in anywhere: the code is the authorisation.',
    'When it prints "Connected", tell me and do nothing else — from then on that process answers Gemies\' messages using this same tool, signed in as me.',
    'If it stops, `npx -y @alia-codea/cli@latest connect` (no code) connects it again.',
    `The code is single-use and expires in ${minutes} minutes. If your sandbox blocks network access, ask me to approve running it with network. Do not install anything else or change any configuration.`,
  ].join('\n');
}
