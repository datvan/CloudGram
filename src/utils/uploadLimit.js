import { Store } from "../redux/store";
import { SPLIT_LARGE } from "../config/features";
import { maxFileBytes } from "./splitPlan";

/** The most bytes this account can send in one file; no limit with the feature off. */
export const uploadLimit = () =>
    SPLIT_LARGE ? maxFileBytes(Store.getState().auth.me?.premium) : Infinity;

/**
 * What one message of a cut file may hold. Premium only when the profile says
 * so: a slice too big for a free account is refused, while one cut small for
 * a Premium account whose profile has not loaded only makes one more message.
 */
export const sliceLimit = () =>
    SPLIT_LARGE
        ? maxFileBytes(Store.getState().auth.me?.premium === true)
        : Infinity;
