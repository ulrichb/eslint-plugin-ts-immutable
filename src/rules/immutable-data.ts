import { TSESTree } from "@typescript-eslint/typescript-estree";
import { all as deepMerge } from "deepmerge";
import { JSONSchema4 } from "json-schema";

import * as ignore from "../common/ignore-options";
import {
  AssumeTypesOption,
  assumeTypesOptionSchema
} from "../common/types-options";
import { isExpected } from "../util/misc";
import {
  checkNode,
  createRule,
  getTypeOfNode,
  RuleContext,
  RuleMetaData,
  RuleResult
} from "../util/rule";
import { inConstructor } from "../util/tree";
import {
  isArrayConstructorType,
  isArrayExpression,
  isArrayType,
  isCallExpression,
  isIdentifier,
  isMemberExpression,
  isNewExpression,
  isObjectConstructorType
} from "../util/typeguard";

// The name of this rule.
export const name = "immutable-data" as const;

// The options this rule can take.
type Options = readonly [
  ignore.IgnorePatternOption &
    ignore.IgnoreAccessorPatternOption &
    AssumeTypesOption
];

// The schema for the rule options.
const schema: JSONSchema4 = [
  deepMerge([
    ignore.ignorePatternOptionSchema,
    ignore.ignoreAccessorPatternOptionSchema,
    assumeTypesOptionSchema
  ])
];

// The default options for the rule.
const defaultOptions: Options = [
  {
    assumeTypes: true
  }
];

// The possible error messages.
const errorMessages = {
  generic: "Modifying an existing object/array is not allowed.",
  object: "Modifying properties of existing object not allowed.",
  array: "Modifying an array is not allowed."
} as const;

// The meta data for this rule.
const meta: RuleMetaData<keyof typeof errorMessages> = {
  type: "suggestion",
  docs: {
    description: "Enforce treating data as immutable.",
    category: "Best Practices",
    recommended: "error"
  },
  messages: errorMessages,
  schema
};

/**
 * Array methods that mutate an array.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/prototype#Methods#Mutator_methods
 */
const arrayMutatorMethods = [
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift"
] as const;

/**
 * Array methods that return a new object (or array) without mutating the original.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/prototype#Methods#Accessor_methods
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/prototype#Iteration_methods
 */
const arrayNewObjectReturningMethods = [
  "concat",
  "slice",
  "filter",
  "map",
  "reduce",
  "reduceRight"
] as const;

/**
 * Array constructor functions that create a new array.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array#Methods
 */
const arrayConstructorFunctions = ["from", "of"] as const;

/**
 * Check if the given assignment expression violates this rule.
 */
function checkAssignmentExpression(
  node: TSESTree.AssignmentExpression,
  context: RuleContext<keyof typeof errorMessages, Options>
): RuleResult<keyof typeof errorMessages, Options> {
  return {
    context,
    descriptors:
      isMemberExpression(node.left) &&
      // Ignore if in a constructor - allow for field initialization.
      !inConstructor(node)
        ? [{ node, messageId: "generic" }]
        : []
  };
}

/**
 * Check if the given node violates this rule.
 */
function checkUnaryExpression(
  node: TSESTree.UnaryExpression,
  context: RuleContext<keyof typeof errorMessages, Options>
): RuleResult<keyof typeof errorMessages, Options> {
  return {
    context,
    descriptors:
      node.operator === "delete" && isMemberExpression(node.argument)
        ? [{ node, messageId: "generic" }]
        : []
  };
}

/**
 * Check if the given node violates this rule.
 */
function checkUpdateExpression(
  node: TSESTree.UpdateExpression,
  context: RuleContext<keyof typeof errorMessages, Options>
): RuleResult<keyof typeof errorMessages, Options> {
  return {
    context,
    descriptors: isMemberExpression(node.argument)
      ? [{ node, messageId: "generic" }]
      : []
  };
}

/**
 * Check if the given node violates this rule.
 */
function checkCallExpression(
  node: TSESTree.CallExpression,
  context: RuleContext<keyof typeof errorMessages, Options>,
  [options]: Options
): RuleResult<keyof typeof errorMessages, Options> {
  const assumeTypesForArrays =
    options.assumeTypes === true ||
    (options.assumeTypes !== false && Boolean(options.assumeTypes.forArrays));
  const assumeTypesForObjects =
    options.assumeTypes === true ||
    (options.assumeTypes !== false && Boolean(options.assumeTypes.forObjects));

  return {
    context,
    descriptors:
      // Potential object mutation?
      isMemberExpression(node.callee) && isIdentifier(node.callee.property)
        ? // Potential array mutation?
          arrayMutatorMethods.some(
            m =>
              m ===
              ((node.callee as TSESTree.MemberExpression)
                .property as TSESTree.Identifier).name
          ) &&
          !isInChainCallAndFollowsNew(
            node.callee,
            context,
            assumeTypesForArrays
          ) &&
          isArrayType(
            getTypeOfNode(node.callee.object, context),
            assumeTypesForArrays,
            node.callee.object
          )
          ? [{ node, messageId: "array" }]
          : // Potential non-array object mutation (Object.assign on identifier)?
          node.callee.property.name === "assign" &&
            node.arguments.length >= 2 &&
            (isIdentifier(node.arguments[0]) ||
              isMemberExpression(node.arguments[0])) &&
            isObjectConstructorType(
              getTypeOfNode(node.callee.object, context),
              assumeTypesForObjects,
              node.callee.object
            )
          ? [{ node, messageId: "object" }]
          : []
        : []
  };
}

/**
 * Check if the given the given MemberExpression is part of a chain and
 * immediately follows a method/function call that returns a new array.
 *
 * If this is the case, then the given MemberExpression is allowed to be
 * a mutator method call.
 */
function isInChainCallAndFollowsNew(
  node: TSESTree.MemberExpression,
  context: RuleContext<keyof typeof errorMessages, Options>,
  assumeArrayTypes: boolean
): boolean {
  return (
    // Check for: [0, 1, 2]
    isArrayExpression(node.object) ||
    // Check for: new Array()
    ((isNewExpression(node.object) &&
      isArrayConstructorType(
        getTypeOfNode(node.object.callee, context),
        assumeArrayTypes,
        node.object.callee
      )) ||
      (isCallExpression(node.object) &&
        isMemberExpression(node.object.callee) &&
        isIdentifier(node.object.callee.property) &&
        // Check for: Object.from(iterable)
        ((arrayConstructorFunctions.some(
          isExpected(node.object.callee.property.name)
        ) &&
          isArrayConstructorType(
            getTypeOfNode(node.object.callee.object, context),
            assumeArrayTypes,
            node.object.callee.object
          )) ||
          // Check for: array.slice(0)
          arrayNewObjectReturningMethods.some(
            isExpected(node.object.callee.property.name)
          ))))
  );
}

// Create the rule.
export const rule = createRule<keyof typeof errorMessages, Options>({
  name,
  meta,
  defaultOptions,
  create(context, [ignoreOptions, ...otherOptions]) {
    const _checkAssignmentExpression = checkNode(
      checkAssignmentExpression,
      context,
      ignoreOptions,
      otherOptions
    );
    const _checkUnaryExpression = checkNode(
      checkUnaryExpression,
      context,
      ignoreOptions,
      otherOptions
    );
    const _checkUpdateExpression = checkNode(
      checkUpdateExpression,
      context,
      ignoreOptions,
      otherOptions
    );
    // This functionality is only avaliable if the parser services are
    // avaliable.
    const _checkCallExpression = checkNode(
      checkCallExpression,
      context,
      ignoreOptions,
      otherOptions
    );

    return {
      AssignmentExpression: _checkAssignmentExpression,
      UnaryExpression: _checkUnaryExpression,
      UpdateExpression: _checkUpdateExpression,
      CallExpression: _checkCallExpression
    };
  }
});
