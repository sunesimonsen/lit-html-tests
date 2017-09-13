import { html, render } from "lit-html";
import { repeat } from "lit-html/lib/repeat";
import expect from "unexpected/unexpected";
import unexpectedCheck from "unexpected-check";
import Generators from "chance-generators";

const { array, natural, sequence, shape } = new Generators(42);

expect.use(unexpectedCheck);

describe("repeat", () => {
  it("is stable while swapping items", () => {
    const initialItems = [1, 2, 3, 4, 5];

    const swapSequence = sequence(() => ({
      from: natural({ max: initialItems.length - 1 }),
      to: natural({ max: initialItems.length - 1 })
    }));

    expect(
      swaps => {
        const container = document.createElement("div");

        const t = items =>
          html`<ul>${repeat(items, i => i, i => html`<li>${i}</li>`)}</ul>`;

        const items = initialItems.slice();

        render(t(items), container);

        for (let swap of swaps) {
          const temp = items[swap.to];
          items[swap.to] = items[swap.from];
          items[swap.from] = temp;

          render(t(items), container);
          expect(container.textContent, "to be", items.join(""));
        }
      },
      "to be valid for all",
      swapSequence
    );
  });
});

export default "";
