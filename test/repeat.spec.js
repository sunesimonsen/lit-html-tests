import { html, render } from "lit-html";
import { repeat } from "lit-html/lib/repeat";
import expect from "unexpected/unexpected";
import unexpectedCheck from "unexpected-check";
import Generators from "chance-generators";

const { integer, n, natural, sequence, shape } = new Generators(42);

expect.use(unexpectedCheck);

const t = items =>
  html`<ul>${repeat(items, i => i, i => html`<li>${i}</li>`)}</ul>`;

describe("repeat", () => {
  it("fails", () => {
    const container = document.createElement("div");

    const t = items =>
      html`<ul>${repeat(items, i => i, i => html`<li>${i}</li>`)}</ul>`;

    const items = [666, 666];
    render(t(items), container);
  });

  it("fails", () => {
    const container = document.createElement("div");

    const t = items =>
      html`<ul>${repeat(items, i => i, i => html`<li>${i}</li>`)}</ul>`;

    const items = [666, 666];
    render(t(items), container);
    expect(container.textContent, "to be", items.join(""));
    render(t(items), container);
    expect(container.textContent, "to be", items.join(""));
  });

  it("is stable while swapping items", () => {
    const plans = shape({
      items: n(natural({ max: 20 }), natural({ min: 1, max: 50 })),
      numberOfSwaps: natural({ max: 50 })
    }).map(({ items, numberOfSwaps }) => {
      const swaps = sequence(
        () => ({
          from: natural({ max: items.length - 1 }),
          to: natural({ max: items.length - 1 })
        }),
        numberOfSwaps
      );

      return {
        items,
        swaps
      };
    });

    expect(
      plan => {
        const container = document.createElement("div");

        const items = plan.items;

        render(t(items), container);

        for (let swap of plan.swaps) {
          const temp = items[swap.to];
          items[swap.to] = items[swap.from];
          items[swap.from] = temp;

          render(t(items), container);
          expect(container.textContent, "to be", items.join(""));
        }
      },
      "to be valid for all",
      {
        generators: [plans],
        maxIterations: 1000
      }
    );
  });
});

export default "";
