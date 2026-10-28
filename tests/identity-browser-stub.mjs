// Browser stand-in for @netlify/identity used only by tests/dev-server.mjs.
const user = { id: 'dev-owner', email: 'owner@fireball.test', name: 'Paul' };
export const getUser = async () => user;
export const refreshSession = async () => null;
export const logout = async () => {};
export const login = async () => user;
export const handleAuthCallback = async () => null;
export const acceptInvite = async () => user;
export const requestPasswordRecovery = async () => {};
export const updateUser = async () => user;
