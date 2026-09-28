// onchainos-lite: dump the upstream clap command model as JSON (patched into a throwaway
// worktree by tools/dump-clap-model.mjs; never part of the upstream build).
use clap::CommandFactory;
use serde_json::{json, Value};

const INT_TYPES: [&str; 10] = ["u8", "u16", "u32", "u64", "usize", "i8", "i16", "i32", "i64", "isize"];

pub fn dump() {
    // clap's recursive builder needs a big stack in debug builds (upstream main uses 8 MiB)
    std::thread::Builder::new()
        .stack_size(32 * 1024 * 1024)
        .spawn(|| {
            let mut cmd = crate::Cli::command();
            cmd.build();
            println!("{}", serde_json::to_string(&walk(&cmd, "")).unwrap());
        })
        .unwrap()
        .join()
        .unwrap();
}

fn walk(cmd: &clap::Command, path: &str) -> Value {
    let args: Vec<Value> = cmd
        .get_arguments()
        .map(|a| {
            let conflicts: Vec<String> = cmd.get_arg_conflicts_with(a).iter().map(|c| c.get_id().to_string()).collect();
            let vp = a.get_value_parser();
            let ty = format!("{:?}", vp.type_id());
            // clap keeps ranged-parser bounds and parser kinds private: probe the parser instead.
            let probe = |v: &str| {
                let long = a.get_long()?;
                let arg = clap::Arg::new(a.get_id().clone()).long(&*Box::leak(long.to_string().into_boxed_str())).action(clap::ArgAction::Set).value_parser(vp.clone());
                clap::Command::new("probe").no_binary_name(true).arg(arg).try_get_matches_from([format!("--{long}={v}")]).err().map(|e| e.to_string())
            };
            let range_probe = if INT_TYPES.contains(&ty.as_str()) { probe("-9223372036854775808") } else { None };
            let boolish = ty == "bool" && probe("yes").is_none();
            let pvs = a.get_possible_values();
            json!({
                "id": a.get_id().to_string(),
                "long": a.get_long(),
                "short": a.get_short().map(|c| c.to_string()),
                "aliases": a.get_all_aliases(),
                "required": a.is_required_set(),
                "global": a.is_global_set(),
                "hide": a.is_hide_set(),
                "positional": a.is_positional(),
                "allowHyphen": a.is_allow_hyphen_values_set(),
                "allowNegative": a.is_allow_negative_numbers_set(),
                "numArgs": a.get_num_args().map(|r| format!("{r:?}")),
                "action": format!("{:?}", a.get_action()),
                "delimiter": a.get_value_delimiter().map(|c| c.to_string()),
                "defaults": a.get_default_values().iter().map(|s| s.to_string_lossy().to_string()).collect::<Vec<_>>(),
                "possible": pvs.iter().map(|p| p.get_name().to_string()).collect::<Vec<_>>(),
                "possibleHidden": pvs.iter().filter(|p| p.is_hide_set()).map(|p| p.get_name().to_string()).collect::<Vec<_>>(),
                "possibleAliases": pvs.iter().flat_map(|p| p.get_name_and_aliases().skip(1).map(|x| x.to_string()).collect::<Vec<_>>()).collect::<Vec<_>>(),
                "rangeProbe": range_probe,
                "boolish": boolish,
                "valueParser": format!("{:?}", a.get_value_parser().type_id()),
                "valueNames": a.get_value_names().map(|v| v.iter().map(|s| s.to_string()).collect::<Vec<_>>()),
                "conflicts": conflicts,
            })
        })
        .collect();
    let groups: Vec<Value> = cmd
        .get_groups()
        .map(|g| json!({ "id": g.get_id().to_string(), "args": g.get_args().map(|i| i.to_string()).collect::<Vec<_>>(), "required": g.is_required_set(), "multiple": g.clone().is_multiple() }))
        .collect();
    let subs: Vec<Value> = cmd
        .get_subcommands()
        .map(|s| {
            let p = if path.is_empty() { s.get_name().to_string() } else { format!("{path} {}", s.get_name()) };
            walk(s, &p)
        })
        .collect();
    json!({ "path": path, "name": cmd.get_name(), "aliases": cmd.get_all_aliases().collect::<Vec<_>>(), "hide": cmd.is_hide_set(), "args": args, "groups": groups, "subcommands": subs })
}
