/** Merge into the sign-in state; see services/account.js for the phases. */
export function setAuth(state) {
    return {
        type: "SET_AUTH",
        state,
    };
}
