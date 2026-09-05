import test from "node:test";
import assert from "node:assert/strict";
import { interpolateEnv, parseModelTarget } from "../src/router/config.js";

test("interpolateEnv supports $VAR, ${VAR} and mixed-case names", () => {
  process.env.OC_TEST_UPPER = "upper-val";
  process.env.oc_test_lower = "lower-val";

  assert.equal(interpolateEnv("$OC_TEST_UPPER"), "upper-val");
  assert.equal(interpolateEnv("${OC_TEST_UPPER}"), "upper-val");
  assert.equal(interpolateEnv("$oc_test_lower"), "lower-val");
  assert.equal(interpolateEnv("${oc_test_lower}"), "lower-val");
  // interpolation inside a larger string (e.g. "Bearer $VAR")
  assert.equal(interpolateEnv("Bearer ${OC_TEST_UPPER}"), "Bearer upper-val");
});

test("interpolateEnv replaces unset variables with empty string and leaves non-strings alone", () => {
  assert.equal(interpolateEnv("$OC_DEFINITELY_UNSET_XYZ"), "");
  assert.equal(interpolateEnv("nope"), "nope");
  assert.equal(interpolateEnv(42), 42);
  assert.equal(interpolateEnv(null), null);
  assert.equal(interpolateEnv(undefined), undefined);
});

test("parseModelTarget resolves explicit provider prefix greedily and falls back to default", () => {
  const cfg = {
    defaultProvider: "claude",
    providers: {
      claude: {},
      agnes: {},
      "ollama-local": {},
    },
  };
  assert.deepEqual(parseModelTarget("agnes:agnes-2.5-flash", cfg), {
    providerId: "agnes",
    modelId: "agnes-2.5-flash",
  });
  // model id itself containing colons is preserved
  assert.deepEqual(parseModelTarget("ollama-local:gemma:31b", cfg), {
    providerId: "ollama-local",
    modelId: "gemma:31b",
  });
  assert.deepEqual(parseModelTarget("sonnet", cfg), {
    providerId: "claude",
    modelId: "sonnet",
  });
});
