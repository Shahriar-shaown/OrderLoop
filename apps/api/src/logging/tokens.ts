/** Injection token for the pino logger. Lives in its own file so the module and the middleware can both import it without a cycle. */
export const LOGGER = Symbol('LOGGER');
