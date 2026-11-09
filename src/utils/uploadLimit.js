import { Store } from "../redux/store";
import { SPLIT_LARGE } from "../config/features";
import { maxFileBytes } from "./splitPlan";

/** The most bytes this account can send in one file; no limit with the feature off. */
export const uploadLimit = () =>
    SPLIT_LARGE ? maxFileBytes(Store.getState().auth.me?.premium) : Infinity;
