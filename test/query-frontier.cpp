// Behavioral UDP fixture: a full nearest-node set must survive a large list
// of irrelevant referrals and still discover a later, closer record holder.
#include <hyperdht/query.hpp>
#include <hyperdht/rpc.hpp>
#include <uv.h>
#include <cstdlib>
#include <iostream>

int main(int argc, char** argv) {
  if (argc != 12) return 2;
  uv_loop_t loop;
  if (uv_loop_init(&loop)) return 2;
  const bool early = std::getenv("QUERY_EARLY") != nullptr;
  uv_timer_t finish_timer;
  bool found = false;
  bool completed = false;
  {
    hyperdht::routing::NodeId target{};
    hyperdht::rpc::RpcSocket socket(&loop, target);
    if (socket.bind(0, "127.0.0.1")) return 2;
    auto query = hyperdht::query::Query::create(socket, target, 2);
    query->set_internal(std::getenv("FRONTIER_INTERNAL") != nullptr);
    for (int i = 1; i < argc; ++i) {
      auto address = hyperdht::compact::Ipv4Address::from_string(
          "127.0.0.1", static_cast<uint16_t>(std::atoi(argv[i])));
      query->add_seed_node(hyperdht::rpc::compute_peer_id(address), address);
    }
    query->on_reply([&](const hyperdht::query::QueryReply& reply) {
      if (reply.value && std::string(reply.value->begin(), reply.value->end()) == "found")
        found = true;
      if (found && early) query->destroy();
    });
    query->on_done([&](int, const std::vector<hyperdht::query::QueryReply>&) {
      completed = true;
      if (early) {
        uv_timer_init(&loop, &finish_timer);
        finish_timer.data = &socket;
        uv_timer_start(&finish_timer, [](uv_timer_t* t) {
          static_cast<hyperdht::rpc::RpcSocket*>(t->data)->close();
          uv_close(reinterpret_cast<uv_handle_t*>(t), nullptr);
        }, 2000, 0);
      } else socket.close();
    });
    query->start();
    uv_run(&loop, UV_RUN_DEFAULT);
  }
  if (uv_loop_close(&loop)) return 2;
  std::cout << (found && completed ? "FRONTIER_OK" : "FRONTIER_FAILED") << '\n';
  return found && completed ? 0 : 1;
}
