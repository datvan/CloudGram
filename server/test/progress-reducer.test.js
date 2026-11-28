import { test } from "node:test";
import assert from "node:assert/strict";
import reducer, {
    activeEntry,
} from "../../src/redux/reducers/progressReducer.js";
import {
    batchProgress,
    completedProgress,
    errorProgress,
    flushUploadProgress,
    queuedProgress,
    queueUploadProgress,
    uploadProgress,
} from "../../src/redux/actions/progressAction.js";

test("index preserves order and previous state across batch and removal", () => {
    let state = reducer(
        undefined,
        batchProgress([queuedProgress("a", "A"), queuedProgress("b", "B")]),
    );
    const previous = state;
    state = reducer(
        state,
        batchProgress([
            uploadProgress("b", 20),
            uploadProgress("a", 30),
            queuedProgress("c", "C"),
        ]),
    );
    assert.deepEqual(
        state.activeProgress.map((entry) => entry.id),
        ["a", "b", "c"],
    );
    assert.equal(activeEntry({ progress: state }, "b").percentage, 20);
    assert.equal(activeEntry({ progress: previous }, "b").type, "QUEUED");
    state = reducer(state, completedProgress("b"));
    assert.deepEqual(
        state.activeProgress.map((entry) => entry.id),
        ["a", "c"],
    );
    assert.equal(activeEntry({ progress: state }, "b"), undefined);
    assert.equal(activeEntry({ progress: state }, "c").name, "C");
    assert.equal(state.finished[0].name, "B");
    state = reducer(state, { type: "REENCRYPT_SKIPPED", id: "a" });
    assert.equal(activeEntry({ progress: state }, "c").name, "C");
});

test("coalesces upload ticks and flushes before terminal and queued actions", () => {
    let state = reducer(undefined, { type: "init" });
    const seen = [];
    const dispatch = (action) => {
        seen.push(action);
        state = reducer(state, action);
    };
    dispatch(queuedProgress("a", "A"));
    queueUploadProgress(dispatch, uploadProgress("a", 10));
    queueUploadProgress(dispatch, uploadProgress("a", 20));
    queueUploadProgress(dispatch, uploadProgress("b", 30));
    dispatch(errorProgress("a", "failed"));
    assert.equal(seen[1].actions.length, 2);
    assert.equal(activeEntry({ progress: state }, "a").type, "ERROR");
    queueUploadProgress(dispatch, uploadProgress("b", 50));
    dispatch(completedProgress("b"));
    flushUploadProgress();
    assert.equal(activeEntry({ progress: state }, "b"), undefined);
    queueUploadProgress(dispatch, uploadProgress("a", 60));
    dispatch(queuedProgress("a"));
    assert.equal(activeEntry({ progress: state }, "a").type, "QUEUED");
});

test("timer dispatches pending upload progress", async () => {
    const actions = [];
    queueUploadProgress(
        (action) => actions.push(action),
        uploadProgress("a", 10),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(actions.length, 1);
    assert.equal(actions[0].actions[0].id, "a");
});
