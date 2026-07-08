export function expandSpawnParams(params: any): any[] {
	if (Array.isArray(params.tasks)) {
		if (params.tasks.length === 0) throw new Error("spawn_agent tasks must not be empty.");
		if (params.tasks.length > 16) throw new Error("spawn_agent tasks is capped at 16; use spawn_agents_on_jsonl/csv for larger batches.");
		const { tasks: _tasks, taskName: _taskName, prompt: _prompt, taskPath: _taskPath, ...defaults } = params;
		return params.tasks.map((task: any, index: number) => {
			if (!task?.taskName || !task?.prompt) throw new Error(`spawn_agent task at index ${index} requires taskName and prompt.`);
			return { ...defaults, ...task };
		});
	}
	if (!params.taskName || !params.prompt) throw new Error("spawn_agent requires taskName and prompt, or a non-empty tasks array.");
	return [params];
}
