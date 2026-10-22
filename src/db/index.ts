// HTTP requests hold no database connection. Keep the existing shutdown hook.
export const prisma = { $disconnect: async () => {} };
