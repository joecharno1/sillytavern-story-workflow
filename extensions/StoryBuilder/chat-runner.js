/** Coordinate existing actions without owning chat state, UI, or provider calls. */
export async function runChatWorkflow({ getState, prepare, generate, apply, updateMemory, onStage }, { signal } = {}) {
    let stage = 'starting';
    const checkAbort = () => {
        if (signal?.aborted) throw new DOMException('The story workflow was paused.', 'AbortError');
    };
    const guarded = async action => {
        checkAbort();
        const result = await action();
        checkAbort();
        return result;
    };
    const readState = async () => {
        const state = await guarded(() => getState());
        if (!state || typeof state !== 'object') throw new Error('The story workflow state is unavailable.');
        return state;
    };
    const ready = state => state.writingComplete && state.editorialReady;
    const stageError = (state, fallback) => typeof state.error === 'string' && state.error.trim() ? state.error : fallback;
    const requireSource = state => {
        if (!state.hasPlan) throw new Error(stageError(state, 'The outline is not ready. Completed work is preserved.'));
        if (!state.sourceCurrent) throw new Error('The source changed. Completed work is preserved; the story was not added.');
    };
    const requireReady = state => {
        requireSource(state);
        if (!ready(state)) throw new Error(stageError(state, 'Writing or editorial checks are unfinished. The draft remains available.'));
    };
    const perform = async (nextStage, action, needed, validate) => {
        stage = nextStage;
        if (onStage) await guarded(() => onStage(stage));
        // Progress callbacks may yield, change the source, or finish a stage.
        // Re-read before launching the next action as well as after it settles.
        let state = await readState();
        if (needed(state)) {
            validate?.(state);
            if (typeof action !== 'function') throw new Error(`The ${stage} action is unavailable.`);
            await guarded(action);
            state = await readState();
        }
        return state;
    };
    try {
        let state = await readState();
        if (!state.applied) {
            stage = 'planning';
            if (!state.hasPlan) state = await perform('planning', prepare, current => !current.applied && !current.hasPlan);
            if (!state.applied) {
                requireSource(state);
                stage = 'writing';
                if (!ready(state)) state = await perform('writing', generate,
                    current => !current.applied && !ready(current), requireSource);
            }
            if (!state.applied) {
                requireReady(state);
                state = await perform('applying', apply, current => !current.applied, requireReady);
                if (!state.applied) throw new Error('The finished story was not added. It remains available to retry.');
            }
        }
        // A successful apply changes the source snapshot. Once applied, only the
        // accepted target controls tracker work; never publish the story again.
        if (state.memoryRequired && !state.memoryComplete) {
            stage = 'tracking';
            if (!state.canTrack) throw new Error('The accepted story changed or cannot be tracked. It will not be added again.');
            state = await perform('tracking', updateMemory,
                current => current.applied && current.memoryRequired && !current.memoryComplete,
                current => { if (!current.canTrack) throw new Error('The accepted story changed. Continuity updating stopped.'); });
            if (!state.applied || (state.memoryRequired && !state.memoryComplete)) {
                throw new Error('The story was added, but continuity updating is unfinished. Retry only the continuity update.');
            }
        }
        checkAbort();
        return { status: 'complete', stage: 'complete' };
    } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') return { status: 'paused', stage };
        return { status: 'needs_attention', stage, error: String(error?.message || error || 'The story workflow could not finish.') };
    }
}
